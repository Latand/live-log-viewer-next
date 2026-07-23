const LIVE_TURN_TEXT_LIMIT = 64 * 1024;
const LIVE_TURN_ITEM_LIMIT = 32;
const LIVE_TURN_OVERFLOW_TEXT_LIMIT = 256 * 1024;
const LIVE_TURN_OVERFLOW_ITEM_LIMIT = 64;

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
  /** Whole older items displaced from the active handoff window. */
  overflowItems?: RuntimeLiveTurnItem[];
  /** Bounded durable representation if the overflow tier itself fills. */
  overflowSummary?: {
    itemCount: number;
    textLength: number;
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

function normalizedItemList(value: unknown): RuntimeLiveTurnItem[] {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item && typeof item.text === "string" && item.text.length > 0)
      .map((item) => ({
        itemId: typeof item.itemId === "string" ? item.itemId : null,
        text: item.text,
        phase: item.phase === "awaiting-echo" ? "awaiting-echo" : "streaming",
        startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
      }));
  }
  return [];
}

function normalizedOverflowSummary(
  value: RuntimeLiveTurn | null | undefined,
): RuntimeLiveTurn["overflowSummary"] | undefined {
  const summary = record(value?.overflowSummary);
  const itemCount = summary?.itemCount;
  const textLength = summary?.textLength;
  return typeof itemCount === "number"
    && Number.isSafeInteger(itemCount)
    && itemCount > 0
    && typeof textLength === "number"
    && Number.isSafeInteger(textLength)
    && textLength >= 0
    ? { itemCount, textLength }
    : undefined;
}

function normalizedItems(value: RuntimeLiveTurn): RuntimeLiveTurnItem[] {
  const overflowItems = normalizedItemList(value.overflowItems);
  const items = normalizedItemList(value.items);
  if (overflowItems.length || items.length || Array.isArray(value.items) || Array.isArray(value.overflowItems)) {
    return [...overflowItems, ...items];
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

function bounded(
  turnId: string,
  items: RuntimeLiveTurnItem[],
  existingSummary?: RuntimeLiveTurn["overflowSummary"],
): RuntimeLiveTurn | null {
  let activeStart = Math.max(0, items.length - LIVE_TURN_ITEM_LIMIT);
  let activeTextLength = items
    .slice(activeStart)
    .reduce((total, item) => total + item.text.length, 0);
  while (activeStart < items.length && activeTextLength > LIVE_TURN_TEXT_LIMIT) {
    activeTextLength -= items[activeStart]!.text.length;
    activeStart += 1;
  }
  const activeItems = items.slice(activeStart);
  let overflowItems = items.slice(0, activeStart);
  let overflowTextLength = overflowItems.reduce((total, item) => total + item.text.length, 0);
  let droppedItemCount = existingSummary?.itemCount ?? 0;
  let droppedTextLength = existingSummary?.textLength ?? 0;
  while (
    overflowItems.length > LIVE_TURN_OVERFLOW_ITEM_LIMIT
    || overflowTextLength > LIVE_TURN_OVERFLOW_TEXT_LIMIT
  ) {
    const [removed, ...rest] = overflowItems;
    if (!removed) break;
    overflowItems = rest;
    overflowTextLength -= removed.text.length;
    droppedItemCount += 1;
    droppedTextLength += removed.text.length;
  }
  const latest = activeItems.at(-1) ?? overflowItems.at(-1);
  if (!latest && droppedItemCount === 0) return null;
  return {
    turnId,
    text: latest?.text ?? "",
    items: activeItems,
    ...(overflowItems.length ? { overflowItems } : {}),
    ...(droppedItemCount > 0
      ? { overflowSummary: { itemCount: droppedItemCount, textLength: droppedTextLength } }
      : {}),
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
  if (
    !turnId
    || (
      !latestText
      && !Array.isArray(live?.items)
      && !Array.isArray(live?.overflowItems)
      && !record(live?.overflowSummary)
    )
  ) return null;
  const normalized = {
    turnId,
    text: latestText,
    items: Array.isArray(live?.items) ? live.items as RuntimeLiveTurnItem[] : undefined,
    overflowItems: Array.isArray(live?.overflowItems)
      ? live.overflowItems as RuntimeLiveTurnItem[]
      : undefined,
    overflowSummary: record(live?.overflowSummary) as RuntimeLiveTurn["overflowSummary"],
  };
  return bounded(
    turnId,
    normalizedItems(normalized),
    normalizedOverflowSummary(normalized),
  );
}

export function runtimeLiveTurnItems(value: RuntimeLiveTurn | null | undefined): RuntimeLiveTurnItem[] {
  return value ? normalizedItems(value) : [];
}

export function retireRuntimeLiveTurnItems(
  value: RuntimeLiveTurn | null | undefined,
  itemIds: unknown,
): RuntimeLiveTurn | null {
  if (!value || !Array.isArray(itemIds)) return value ?? null;
  const owned = new Set(itemIds.filter((item): item is string => typeof item === "string" && item.length > 0));
  if (!owned.size) return value;
  return bounded(
    value.turnId,
    normalizedItems(value).filter((item) => !item.itemId || !owned.has(item.itemId)),
    normalizedOverflowSummary(value),
  );
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
  return bounded(turnId, items, normalizedOverflowSummary(value));
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
      text: identity.text || existing.text,
      phase: "awaiting-echo",
      completedAt: occurredAt,
    };
    return bounded(turnId, items, normalizedOverflowSummary(value));
  }
  const latest = current.at(-1);
  if (latest?.phase === "streaming") {
    return bounded(turnId, [
      ...current.slice(0, -1),
      {
        ...latest,
        itemId: identity.itemId,
        text: identity.text || latest.text,
        phase: "awaiting-echo",
        completedAt: occurredAt,
      },
    ], normalizedOverflowSummary(value));
  }
  if (!identity.text) return value ?? null;
  return bounded(turnId, [...current, {
    itemId: identity.itemId,
    text: identity.text,
    phase: "awaiting-echo",
    startedAt: occurredAt,
    completedAt: occurredAt,
  }], normalizedOverflowSummary(value));
}
