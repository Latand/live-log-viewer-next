const LIVE_TURN_TEXT_LIMIT = 64 * 1024;
const LIVE_TURN_ITEM_LIMIT = 32;

export type RuntimeLiveTurnItemPhase = "streaming" | "awaiting-echo";

export interface RuntimeLiveTurnItem {
  itemId: string | null;
  text: string;
  phase: RuntimeLiveTurnItemPhase;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RuntimeLiveTurn {
  turnId: string;
  /** Latest assistant item text retained for compatibility with existing status consumers. */
  text: string;
  /** Assistant items awaiting canonical transcript ownership, in response order. */
  items?: RuntimeLiveTurnItem[];
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

function normalizedItems(value: RuntimeLiveTurn): RuntimeLiveTurnItem[] {
  if (Array.isArray(value.items)) {
    return value.items
      .filter((item) => item && typeof item.text === "string" && item.text.length > 0)
      .map((item) => ({
        itemId: typeof item.itemId === "string" ? item.itemId : null,
        text: item.text,
        phase: item.phase === "awaiting-echo" ? "awaiting-echo" : "streaming",
        startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
      }));
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
  let kept = items.slice(-LIVE_TURN_ITEM_LIMIT);
  let excess = kept.reduce((total, item) => total + item.text.length, 0) - LIVE_TURN_TEXT_LIMIT;
  if (excess > 0) {
    kept = kept.map((item) => {
      if (excess <= 0) return item;
      const trim = Math.min(excess, item.text.length);
      excess -= trim;
      return { ...item, text: item.text.slice(trim) };
    }).filter((item) => item.text.length > 0);
  }
  const latest = kept.at(-1);
  return latest ? { turnId, text: latest.text, items: kept } : null;
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
  if (!turnId || (!latestText && !Array.isArray(live?.items))) return null;
  return bounded(turnId, normalizedItems({
    turnId,
    text: latestText,
    items: Array.isArray(live?.items) ? live.items as RuntimeLiveTurnItem[] : undefined,
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
      text: existing.text || identity.text,
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
        text: latest.text || identity.text,
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
