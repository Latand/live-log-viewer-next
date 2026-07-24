export const LIVE_TURN_TEXT_LIMIT = 64 * 1024;
export const LIVE_TURN_ITEM_LIMIT = 32;
export const LIVE_TURN_OVERFLOW_LIMIT = 512;

export type RuntimeLiveTurnItemPhase = "streaming" | "awaiting-echo";

export interface RuntimeLiveTurnItem {
  itemId: string | null;
  text: string;
  phase: RuntimeLiveTurnItemPhase;
  startedAt: string | null;
  completedAt: string | null;
  /** Characters omitted from the live projection to honor its text bound. The
      canonical transcript remains authoritative; the UI renders this count. */
  omittedChars?: number;
  /** Extremely old descriptors folded into this explicit bounded summary. */
  omittedItems?: number;
}

export interface RuntimeLiveTurn {
  turnId: string;
  /** Latest assistant item text retained for compatibility with existing status consumers. */
  text: string;
  /** Assistant items awaiting canonical transcript ownership, in response order. */
  items?: RuntimeLiveTurnItem[];
  /** Older unclaimed items displaced from the 32-item hot window. Descriptors
      remain durable in journal snapshots and preserve response order/identity. */
  overflow?: RuntimeLiveTurnItem[];
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const utf8Length = (value: string) => utf8Encoder.encode(value).length;

function trimUtf8Start(value: string, bytes: number): {
  omittedChars: number;
  text: string;
} {
  const encoded = utf8Encoder.encode(value);
  let start = Math.min(bytes, encoded.length);
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  const omitted = utf8Decoder.decode(encoded.subarray(0, start));
  return {
    omittedChars: [...omitted].length,
    text: utf8Decoder.decode(encoded.subarray(start)),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      const type = text(item.type);
      return type === "text" || type === "input_text" || type === "output_text"
        ? text(item.text)
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function itemIdentity(value: unknown): { itemId: string | null; text: string } | null {
  const item = record(value);
  if (!item) return null;
  const type = text(item.type);
  const message = record(item.message);
  const role = text(item.role) || text(message?.role);
  const assistant = type === "agentMessage"
    || type === "agent_message"
    || type === "assistant"
    || (type === "message" && role === "assistant");
  if (!assistant) return null;
  return {
    itemId: text(item.id) || text(item.uuid) || text(message?.id) || null,
    text: text(item.text) || contentText(item.content) || contentText(message?.content),
  };
}

function normalizedList(value: unknown): RuntimeLiveTurnItem[] {
  if (!Array.isArray(value)) return [];
  return value
      .filter((item) =>
        item
        && typeof item.text === "string"
        && (item.text.length > 0 || (item.omittedChars ?? 0) > 0 || (item.omittedItems ?? 0) > 0))
      .map((item) => ({
        itemId: typeof item.itemId === "string" ? item.itemId : null,
        text: item.text,
        phase: item.phase === "awaiting-echo" ? "awaiting-echo" : "streaming",
        startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
        ...(typeof item.omittedChars === "number" && item.omittedChars > 0
          ? { omittedChars: Math.floor(item.omittedChars) }
          : {}),
        ...(typeof item.omittedItems === "number" && item.omittedItems > 0
          ? { omittedItems: Math.floor(item.omittedItems) }
          : {}),
      }));
}

function normalizedItems(value: RuntimeLiveTurn): RuntimeLiveTurnItem[] {
  if (Array.isArray(value.items) || Array.isArray(value.overflow)) {
    return [...normalizedList(value.overflow), ...normalizedList(value.items)];
  }
  return value.text
    ? [{
      itemId: null,
      text: value.text,
      phase: "streaming",
      startedAt: null,
      completedAt: null,
    }]
    : [];
}

function bounded(turnId: string, items: RuntimeLiveTurnItem[]): RuntimeLiveTurn | null {
  const descriptorLimit = LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT;
  const omittedCount = items.length > descriptorLimit
    ? items.length - descriptorLimit + 1
    : 0;
  const omitted = items.slice(0, omittedCount);
  let kept = omitted.length
    ? [{
      itemId: null,
      text: "",
      phase: "awaiting-echo" as const,
      startedAt: omitted[0]?.startedAt ?? null,
      completedAt: omitted.at(-1)?.completedAt ?? null,
      omittedItems: omitted.reduce((total, item) =>
        total + (item.omittedItems ?? 1), 0),
      omittedChars: omitted.reduce((total, item) =>
        total + [...item.text].length + (item.omittedChars ?? 0), 0),
    }, ...items.slice(omittedCount)]
    : items;
  let excess = kept.reduce((total, item) => total + utf8Length(item.text), 0) - LIVE_TURN_TEXT_LIMIT;
  if (excess > 0) {
    kept = kept.map((item) => {
      if (excess <= 0) return item;
      const before = utf8Length(item.text);
      const trimmed = trimUtf8Start(item.text, excess);
      excess -= before - utf8Length(trimmed.text);
      return {
        ...item,
        text: trimmed.text,
        omittedChars: (item.omittedChars ?? 0) + trimmed.omittedChars,
      };
    });
  }
  const latest = kept.at(-1);
  if (!latest) return null;
  const activeStart = Math.max(0, kept.length - LIVE_TURN_ITEM_LIMIT);
  const overflow = kept.slice(0, activeStart);
  const active = kept.slice(activeStart);
  return {
    turnId,
    text: latest.text,
    items: active,
    ...(overflow.length ? { overflow } : {}),
  };
}

function itemsForTurn(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  occurredAt: string | null,
): RuntimeLiveTurnItem[] {
  if (!value) return [];
  const items = normalizedItems(value);
  if (value.turnId === turnId) return items;
  return items.map((item) => item.phase === "streaming"
    ? { ...item, phase: "awaiting-echo", completedAt: item.completedAt ?? occurredAt }
    : item);
}

export function normalizeRuntimeLiveTurn(value: unknown): RuntimeLiveTurn | null {
  const live = record(value);
  const turnId = text(live?.turnId);
  const latestText = text(live?.text);
  if (!turnId || (!latestText && !Array.isArray(live?.items) && !Array.isArray(live?.overflow))) return null;
  return bounded(turnId, normalizedItems({
    turnId,
    text: latestText,
    items: Array.isArray(live?.items) ? live.items as RuntimeLiveTurnItem[] : undefined,
    overflow: Array.isArray(live?.overflow) ? live.overflow as RuntimeLiveTurnItem[] : undefined,
  }));
}

export function runtimeLiveTurnItems(value: RuntimeLiveTurn | null | undefined): RuntimeLiveTurnItem[] {
  return value ? normalizedItems(value) : [];
}

export function appendRuntimeLiveTurnDelta(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  fragment: string,
  occurredAt: string | null = null,
): RuntimeLiveTurn | null {
  if (!fragment) return value ?? null;
  const current = itemsForTurn(value, turnId, occurredAt);
  const latest = current.at(-1);
  const items = latest?.phase === "streaming"
    ? [...current.slice(0, -1), { ...latest, text: latest.text + fragment }]
    : [...current, {
      itemId: null,
      text: fragment,
      phase: "streaming" as const,
      startedAt: occurredAt,
      completedAt: null,
    }];
  return bounded(turnId, items);
}

export function completeRuntimeLiveTurnItem(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  item: unknown,
  occurredAt: string | null = null,
): RuntimeLiveTurn | null {
  const identity = itemIdentity(item);
  if (!identity) return value ?? null;
  const current = itemsForTurn(value, turnId, occurredAt);
  const existingIndex = identity.itemId
    ? current.findIndex((candidate) => candidate.itemId === identity.itemId)
    : -1;
  if (existingIndex >= 0) {
    const existing = current[existingIndex]!;
    const items = current.slice();
    items[existingIndex] = {
      ...existing,
      /* A non-empty completed item is authoritative: it repairs missed streamed
         suffixes and may legitimately rewrite a divergent draft. Engines that
         complete with an empty body leave the observed stream intact. */
      text: identity.text || existing.text,
      ...(identity.text ? { omittedChars: undefined } : {}),
      phase: "awaiting-echo",
      completedAt: occurredAt,
    };
    return bounded(turnId, items);
  }
  const latest = current.at(-1);
  if (latest?.phase === "streaming") {
    return bounded(turnId, [
      ...current.slice(0, -1),
      {
        ...latest,
        itemId: identity.itemId,
        text: identity.text || latest.text,
        ...(identity.text ? { omittedChars: undefined } : {}),
        phase: "awaiting-echo",
        completedAt: occurredAt,
      },
    ]);
  }
  if (!identity.text) return value ?? null;
  return bounded(turnId, [...current, {
    itemId: identity.itemId,
    text: identity.text,
    phase: "awaiting-echo",
    startedAt: occurredAt,
    completedAt: occurredAt,
  }]);
}
