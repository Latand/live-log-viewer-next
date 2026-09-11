import { isDeepStrictEqual } from "node:util";

/** The host owns the connection, account, generation and RPC cancellation. */
export type CodexHistoryRpc = (
  method: string, params: Record<string, unknown>, timeoutMs: number,
) => Promise<unknown>;

type ObjectValue = Record<string, unknown>;
export interface CodexHistoryIdentity { threadId: string; path: string }
export interface CodexHistoryItem extends ObjectValue { id: string; type: string }
export interface CodexHistoryTurn extends ObjectValue {
  id: string;
  items: CodexHistoryItem[];
  itemsView: "full";
}
export interface CodexHistoryOptions {
  /** Absolute deadline supplied by the existing caller; never renewed per page. */
  deadlineAt: number;
  maxBytes?: number;
  /** Counts every RPC response, including metadata. */
  maxPages?: number;
  turnsPerPage?: number;
  itemsPerPage?: number;
  sortDirection?: "asc" | "desc";
  itemsView?: "notLoaded" | "summary" | "full";
}
export interface CodexHistoryPage {
  method: string;
  turnId?: string;
  cursor: string | null;
  nextCursor: string | null;
  backwardsCursor?: string | null;
}
type UnknownReason = "identity" | "malformed" | "cursor" | "bytes" | "pages" | "deadline" | "transport" | "not-materialized" | "not-observed" | "conflicting-record";
export type CodexHistoryResult =
  | { state: "complete"; identity: CodexHistoryIdentity; turns: CodexHistoryTurn[]; pages: CodexHistoryPage[]; bytes: number }
  | { state: "unknown"; reason: UnknownReason }
  | { state: "legacy-fallback"; reason: "unsupported" };

/** A complete canonical turn was read, but older unrelated turns were not.
 * This can prove a positive delivery; it cannot prove absence or uniqueness
 * across the whole thread, and must never authorize a resend. */
export type CodexDeliveryHistoryResult = CodexHistoryResult
  | (Omit<Extract<CodexHistoryResult, {state: "complete"}>, "state"> & {state: "observed"});
type ObservedHistory = Extract<CodexDeliveryHistoryResult, {state: "observed"}>;

class ReadFailure extends Error {
  constructor(readonly reason: UnknownReason | "unsupported") { super(reason); }
}
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function requireValue(condition: unknown, reason: UnknownReason = "malformed"): asserts condition {
  if (!condition) throw new ReadFailure(reason);
}

/** Explicit capability errors only. Permission, persistence and network errors are unknown. */
function unsupported(error: unknown): boolean {
  if (object(error)?.code === -32601) return true;
  const message = error instanceof Error ? error.message : object(error)?.message;
  return typeof message === "string" && /^Codex app-server request failed: (?:method not found|unknown method [`'"]?thread\/(?:turns|items)\/list[`'"]?|(?:list_turns|list_items) is not supported yet)[.!]?$/i.test(message);
}

function notMaterialized(error: unknown): boolean {
  const message = error instanceof Error ? error.message : object(error)?.message;
  return typeof message === "string" && /\bnot materialized yet\b/i.test(message)
    && /\bbefore (?:the )?first user message\b/i.test(message);
}

/** Counts JSON wire bytes before retaining a response. Large strings fail before encoding. */
function jsonBytes(value: unknown, remaining: number, depth = 0): number {
  requireValue(depth <= 64);
  let size = 0;
  const add = (n: number) => { size += n; requireValue(size <= remaining, "bytes"); };
  if (typeof value === "string") {
    requireValue(Buffer.byteLength(value) <= remaining, "bytes");
    add(Buffer.byteLength(JSON.stringify(value)));
  } else if (value === null || typeof value === "boolean" || typeof value === "number") {
    requireValue(typeof value !== "number" || Number.isFinite(value));
    add(String(value).length);
  } else if (Array.isArray(value)) {
    add(2);
    for (let i = 0; i < value.length; i++) {
      if (i) add(1);
      add(jsonBytes(value[i], remaining - size, depth + 1));
    }
  } else {
    const row = object(value);
    requireValue(row && Object.getPrototypeOf(row) === Object.prototype);
    add(2);
    let first = true;
    for (const key of Object.keys(row)) {
      if (!first) add(1);
      first = false;
      add(jsonBytes(key, remaining - size, depth + 1));
      add(1);
      add(jsonBytes(row[key], remaining - size, depth + 1));
    }
  }
  return size;
}

function validContent(value: unknown): value is ObjectValue[] {
  return Array.isArray(value) && value.length > 0 && value.every((input) => {
    const row = object(input);
    if (!row) return false;
    switch (row.type) {
      case "text": {
        if (typeof row.text !== "string") return false;
        const length = Buffer.byteLength(row.text);
        return row.text_elements === undefined || (Array.isArray(row.text_elements) && row.text_elements.every(element => {
          const span = object(element);
          const range = object(span?.byteRange);
          return !!range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
            && (range.start as number) >= 0 && (range.start as number) <= (range.end as number)
            && (range.end as number) <= length
            && (span?.placeholder === undefined || span.placeholder === null || typeof span.placeholder === "string");
        }));
      }
      case "image": return nonempty(row.url) && (row.detail === undefined || row.detail === null || ["auto", "low", "high", "original"].includes(String(row.detail)));
      case "audio": return nonempty(row.url);
      case "localImage": return nonempty(row.path) && (row.detail === undefined || row.detail === null || ["auto", "low", "high", "original"].includes(String(row.detail)));
      case "localAudio": return nonempty(row.path);
      case "skill": case "mention": return nonempty(row.path) && nonempty(row.name);
      default: return false;
    }
  });
}
function item(value: unknown): CodexHistoryItem {
  const row = object(value);
  requireValue(row && nonempty(row.id) && nonempty(row.type));
  if (row.type === "userMessage") {
    requireValue(validContent(row.content));
    requireValue(row.clientId === undefined || row.clientId === null || nonempty(row.clientId));
  }
  return row as CodexHistoryItem;
}

/**
 * Complete means all requested pages were read, not an atomic snapshot or proof
 * that a missing message was never delivered. No mutation, polling or cache.
 * RPC must enforce its own frame cap: this seam receives already parsed values.
 */
export async function readCodexHistory(
  rpc: CodexHistoryRpc, identity: CodexHistoryIdentity, options: CodexHistoryOptions,
): Promise<CodexHistoryResult> {
  const result = await readHistory(rpc, identity, options);
  return result.state === "observed" ? {state: "unknown", reason: "malformed"} : result;
}

/** Read through the first complete turn containing a requested client ID.
 * Full item hydration and all identity/cursor/deadline checks still apply.
 * Callers must compare its canonical content with the frozen input. */
export async function readCodexDeliveryHistory(
  rpc: CodexHistoryRpc, identity: CodexHistoryIdentity, options: CodexHistoryOptions,
  clientIds: readonly string[],
  accept?: (history: ObservedHistory) => boolean,
): Promise<CodexDeliveryHistoryResult> {
  if (!clientIds.length || clientIds.length > 2000 || !clientIds.every(nonempty)) return {state: "unknown", reason: "malformed"};
  return readHistory(rpc, identity, options, new Set(clientIds), accept);
}

async function readHistory(
  rpc: CodexHistoryRpc, identity: CodexHistoryIdentity, options: CodexHistoryOptions,
  matchingClientIds?: ReadonlySet<string>,
  accept?: (history: ObservedHistory) => boolean,
): Promise<CodexDeliveryHistoryResult> {
  try {
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    const maxPages = options.maxPages ?? 128;
    const turnsPerPage = options.turnsPerPage ?? 16;
    const itemsPerPage = options.itemsPerPage ?? 32;
    const sortDirection = options.sortDirection ?? "asc";
    const itemsView = options.itemsView ?? "notLoaded";
    requireValue(nonempty(identity.threadId) && nonempty(identity.path), "identity");
    requireValue(Number.isFinite(options.deadlineAt));
    for (const n of [maxBytes, maxPages, turnsPerPage, itemsPerPage]) requireValue(Number.isSafeInteger(n) && n > 0);
    requireValue(turnsPerPage <= 100 && itemsPerPage <= 100);
    requireValue(["asc", "desc"].includes(sortDirection) && ["notLoaded", "summary", "full"].includes(itemsView));
    // Freeze caller input before the first asynchronous boundary.
    const target = { ...identity };
    const deadlineAt = options.deadlineAt;
    let bytes = 0;
    let requests = 0;
    const pages: CodexHistoryPage[] = [];
    const call = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
      const remainingMs = deadlineAt - Date.now();
      requireValue(remainingMs > 0, "deadline");
      requireValue(requests++ < maxPages, "pages");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: unknown;
      try {
        response = await Promise.race([
          rpc(method, params, remainingMs),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadFailure("deadline")), remainingMs); }),
        ]);
      } catch (error) {
        if (error instanceof ReadFailure) throw error;
        // This is still unavailable history. Preserve the native first-turn
        // diagnostic so the host can distinguish initial delivery from a
        // transport failure; a later pagination failure grants no such fact.
        if (((method === "thread/read" && requests === 1)
          || (method === "thread/turns/list" && requests === 2 && params.cursor === null))
          && notMaterialized(error)) {
          throw new ReadFailure("not-materialized");
        }
        throw new ReadFailure(unsupported(error) ? "unsupported" : "transport");
      } finally { clearTimeout(timer); }
      requireValue(Date.now() < deadlineAt, "deadline");
      bytes += jsonBytes(response, maxBytes - bytes);
      requireValue(Date.now() < deadlineAt, "deadline");
      const result = object(response);
      requireValue(result && !Object.hasOwn(result, "error"));
      // Detach retained evidence from a mutable RPC fixture/transport buffer.
      return structuredClone(result);
    };
    const metadata = object((await call("thread/read", { threadId: target.threadId, includeTurns: false })).thread);
    requireValue(metadata?.id === target.threadId && metadata?.path === target.path, "identity");
    requireValue(metadata?.ephemeral !== true, "identity");

    const readPage = async (method: string, params: ObjectValue, cursor: string | null, seen: Set<string>, turnId?: string) => {
      const result = await call(method, { ...params, cursor });
      requireValue(result.threadId === undefined || result.threadId === target.threadId, "identity");
      requireValue(result.turnId === undefined || result.turnId === turnId, "identity");
      requireValue(Array.isArray(result.data));
      // Require an explicit end marker. Omission cannot establish completeness.
      requireValue(result.nextCursor === null || nonempty(result.nextCursor));
      requireValue(result.backwardsCursor === undefined || result.backwardsCursor === null || nonempty(result.backwardsCursor));
      const nextCursor = result.nextCursor as string | null;
      if (nextCursor !== null) {
        requireValue(result.data.length > 0 && !seen.has(nextCursor), "cursor");
        seen.add(nextCursor);
      }
      pages.push({ method, ...(turnId ? { turnId } : {}), cursor, nextCursor,
        ...(result.backwardsCursor !== undefined ? { backwardsCursor: result.backwardsCursor as string | null } : {}) });
      return { data: result.data, nextCursor };
    };
    const turns: CodexHistoryTurn[] = [];
    const turnIds = new Set<string>();
    const turnCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await readPage("thread/turns/list", { threadId: target.threadId, limit: turnsPerPage, sortDirection, itemsView }, cursor, turnCursors);
      for (const raw of page.data) {
        const turn = object(raw);
        requireValue(turn && nonempty(turn.id) && Array.isArray(turn.items));
        requireValue(!turnIds.has(turn.id), "cursor");
        turnIds.add(turn.id);
        requireValue(["completed", "interrupted", "failed", "inProgress"].includes(String(turn.status)));
        requireValue(turn.threadId === undefined || turn.threadId === target.threadId, "identity");
        turn.items.forEach(item);
        // 0.154 schema defaults omitted itemsView to full. A partial cursor
        // from an older protocol forces a fresh item traversal from its start.
        const view = turn.itemsView ?? (Object.hasOwn(turn, "itemsView") ? null : "full");
        requireValue(["full", "summary", "notLoaded"].includes(String(view)));
        requireValue(turn.itemsBackwardsCursor === undefined || turn.itemsBackwardsCursor === null || nonempty(turn.itemsBackwardsCursor));
        let items: CodexHistoryItem[];
        if (view === "full" && !turn.itemsBackwardsCursor) {
          items = turn.items.map(item);
        } else {
          items = [];
          const itemCursors = new Set<string>();
          let itemCursor: string | null = null;
          do {
            const itemPage = await readPage("thread/items/list", { threadId: target.threadId, turnId: turn.id, limit: itemsPerPage, sortDirection: "asc" }, itemCursor, itemCursors, turn.id);
            for (const entry of itemPage.data) {
              const row = object(entry);
              requireValue(row?.turnId === turn.id, "identity");
              const canonical = item(row?.item);
              requireValue(canonical.threadId === undefined || canonical.threadId === target.threadId, "identity");
              items.push(canonical);
            }
            itemCursor = itemPage.nextCursor;
          } while (itemCursor !== null);
        }
        const ids = new Set<string>();
        for (const canonical of items) {
          requireValue(!ids.has(canonical.id), "cursor");
          requireValue(canonical.threadId === undefined || canonical.threadId === target.threadId, "identity");
          requireValue(canonical.turnId === undefined || canonical.turnId === turn.id, "identity");
          ids.add(canonical.id);
        }
        turns.push({ ...turn, id: turn.id, items, itemsView: "full" });
        if (matchingClientIds && items.some(canonical => canonical.type === "userMessage"
          && typeof canonical.clientId === "string" && matchingClientIds.has(canonical.clientId))) {
          const observed: ObservedHistory = {state: "observed", identity: target, turns, pages, bytes};
          if (!accept || accept(observed)) {
            requireValue(Date.now() < deadlineAt, "deadline");
            return observed;
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    requireValue(Date.now() < deadlineAt, "deadline");
    return { state: "complete", identity: target, turns, pages, bytes };
  } catch (error) {
    if (error instanceof ReadFailure) return error.reason === "unsupported"
      ? { state: "legacy-fallback", reason: "unsupported" }
      : { state: "unknown", reason: error.reason };
    return { state: "unknown", reason: "malformed" };
  }
}

export interface CodexHistoryDeliveryTarget {
  clientId: string;
  /** Exact native input frozen at admission, including attachments and markers. */
  content: ObjectValue[];
  /** Null explicitly means the native turn is not yet known; never omit it. */
  turnId: string | null;
  itemId?: string;
}
export type CodexHistoryDeliveryResult =
  | { state: "found"; identity: CodexHistoryIdentity; turnId: string; item: CodexHistoryItem }
  | Exclude<CodexHistoryResult, { state: "complete" }>;

export function normalizedCodexHistoryContent(content: ObjectValue[]): ObjectValue[] {
  return content.map((input) => {
    if (input.type === "text") return {
      ...input,
      text_elements: ((input.text_elements ?? []) as ObjectValue[]).map(span => ({
        ...span, placeholder: span.placeholder ?? null,
      })),
    };
    if (input.type === "image" || input.type === "localImage") return { ...input, detail: input.detail ?? null };
    return input;
  });
}

/** Absence, even after complete traversal, never authorizes resend or deletion. */
export function findCodexHistoryDelivery(history: CodexDeliveryHistoryResult, target: CodexHistoryDeliveryTarget): CodexHistoryDeliveryResult {
  if (history.state !== "complete" && history.state !== "observed") return history;
  if (!nonempty(target.clientId) || !validContent(target.content)
      || !(target.turnId === null || nonempty(target.turnId))
      || !(target.itemId === undefined || nonempty(target.itemId))) return { state: "unknown", reason: "malformed" };
  const candidates = history.turns.flatMap((turn) => turn.items
    .filter((entry) => entry.type === "userMessage" && entry.clientId === target.clientId)
    .map((entry) => ({ turnId: turn.id, item: entry })));
  if (!candidates.length) return { state: "unknown", reason: "not-observed" };
  if (candidates.length !== 1) return { state: "unknown", reason: "conflicting-record" };
  const match = candidates[0];
  if ((target.turnId !== null && target.turnId !== match.turnId)
      || (target.itemId !== undefined && target.itemId !== match.item.id)
      || !isDeepStrictEqual(normalizedCodexHistoryContent(target.content), normalizedCodexHistoryContent(match.item.content as ObjectValue[]))) {
    return { state: "unknown", reason: "conflicting-record" };
  }
  return { state: "found", identity: history.identity, ...match };
}
