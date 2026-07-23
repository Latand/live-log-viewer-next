"use client";

import type { FeedEntry } from "@/components/feed/parse";
import { useSyncExternalStore } from "react";
import {
  LIVE_TURN_ITEM_LIMIT,
  LIVE_TURN_OVERFLOW_LIMIT,
  runtimeLiveTurnItems,
  type RuntimeLiveTurn,
  type RuntimeLiveTurnItem,
} from "@/lib/runtime/liveTurn";

interface CanonicalAssistantItem {
  sourceId: string | null;
  text: string;
  at: number | null;
}

const CLAIM_LIMIT = LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT;
const claims = new Map<string, ReadonlySet<string>>();
const claimListeners = new Set<() => void>();
const EMPTY_CLAIMS: ReadonlySet<string> = new Set();

const storageKey = (conversationId: string) => `llvAssistantClaims:${conversationId}`;

function sourceIdOf({ item }: FeedEntry): string | null {
  return "sourceId" in item && typeof item.sourceId === "string" && item.sourceId
    ? item.sourceId
    : null;
}

export function readCanonicalAssistantClaims(conversationId: string): ReadonlySet<string> {
  const cached = claims.get(conversationId);
  if (cached) return cached;
  if (typeof window === "undefined") return EMPTY_CLAIMS;
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(conversationId)) ?? "[]") as unknown;
    const restored = new Set(
      Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === "string" && value.length > 0).slice(-CLAIM_LIMIT)
        : [],
    );
    claims.set(conversationId, restored);
    return restored;
  } catch {
    claims.set(conversationId, EMPTY_CLAIMS);
    return EMPTY_CLAIMS;
  }
}

function writeClaims(conversationId: string, next: ReadonlySet<string>): void {
  claims.set(conversationId, next);
  try {
    if (next.size) sessionStorage.setItem(storageKey(conversationId), JSON.stringify([...next]));
    else sessionStorage.removeItem(storageKey(conversationId));
  } catch {
    /* quota / opaque origin: in-memory claims still protect this mount */
  }
}

/** Persist canonical ownership by response identity before its row can leave the
    capped or filtered feed. */
export function publishCanonicalAssistantClaims(
  conversationId: string,
  feed: readonly FeedEntry[],
): void {
  if (!conversationId) return;
  const previous = readCanonicalAssistantClaims(conversationId);
  const discovered = feed.flatMap((entry) => {
    const sourceId = sourceIdOf(entry);
    return sourceId ? [sourceId] : [];
  });
  if (!discovered.some((sourceId) => !previous.has(sourceId))) return;
  const merged = new Set(previous);
  for (const sourceId of discovered) {
    merged.delete(sourceId);
    merged.add(sourceId);
  }
  while (merged.size > CLAIM_LIMIT) {
    const oldest = merged.values().next().value;
    if (oldest === undefined) break;
    merged.delete(oldest);
  }
  writeClaims(conversationId, merged);
  for (const listener of claimListeners) listener();
}

/** Carry durable response ownership through provisional/path identity adoption. */
export function adoptCanonicalAssistantClaims(from: string, to: string): void {
  if (!from || from === to) return;
  const source = readCanonicalAssistantClaims(from);
  if (!source.size) return;
  const merged = new Set(source);
  for (const sourceId of readCanonicalAssistantClaims(to)) {
    merged.delete(sourceId);
    merged.add(sourceId);
  }
  while (merged.size > CLAIM_LIMIT) {
    const oldest = merged.values().next().value;
    if (oldest === undefined) break;
    merged.delete(oldest);
  }
  writeClaims(to, merged);
  writeClaims(from, EMPTY_CLAIMS);
  for (const listener of claimListeners) listener();
}

export function useCanonicalAssistantClaims(conversationId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      claimListeners.add(listener);
      return () => claimListeners.delete(listener);
    },
    () => readCanonicalAssistantClaims(conversationId),
    () => EMPTY_CLAIMS,
  );
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalAssistantItems(feed: readonly FeedEntry[]): CanonicalAssistantItem[] {
  return feed.flatMap((entry) => {
    const { item } = entry;
    const sourceId = sourceIdOf(entry);
    if (item.kind === "prose") {
      return [{
        sourceId,
        text: item.text.trim(),
        at: timestamp(item.ts),
      }];
    }
    if (!sourceId) return [];
    return [{
      sourceId,
      text: "",
      at: item.kind === "review" ? timestamp(item.ts) : null,
    }];
  });
}

/**
 * Canonical transcript rows claim completed live items by response identity.
 * Older engine records without ids use a timestamp-fenced text echo.
 */
export function visibleRuntimeLiveTurnItems(
  liveTurn: RuntimeLiveTurn | null | undefined,
  feed: readonly FeedEntry[],
  persistedClaims: ReadonlySet<string> = EMPTY_CLAIMS,
): RuntimeLiveTurnItem[] {
  const canonical = canonicalAssistantItems(feed);
  const currentClaims = new Set(canonical.flatMap((item) => item.sourceId ? [item.sourceId] : []));
  const claimed = new Set<number>();
  return runtimeLiveTurnItems(liveTurn).filter((live) => {
    if (live.phase === "streaming") return true;
    if (live.itemId && (persistedClaims.has(live.itemId) || currentClaims.has(live.itemId))) return false;
    let owner = live.itemId
      ? canonical.findIndex((item, index) => !claimed.has(index) && item.sourceId === live.itemId)
      : -1;
    const liveText = live.text.trim();
    if (owner < 0 && !live.itemId && liveText) {
      const startedAt = timestamp(live.startedAt);
      owner = canonical.findIndex((item, index) =>
        !claimed.has(index)
        && item.text === liveText
        && (startedAt === null || item.at === null || item.at >= startedAt),
      );
    }
    if (owner < 0) return true;
    claimed.add(owner);
    return false;
  });
}

export function resetCanonicalAssistantClaimsForTests(): void {
  claims.clear();
  claimListeners.clear();
}
