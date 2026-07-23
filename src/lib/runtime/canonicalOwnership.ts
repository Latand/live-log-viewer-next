export const CANONICAL_LAUNCH_OWNERSHIP_LIMIT = 8;
export const CANONICAL_OUTBOX_OWNERSHIP_LIMIT = 32;
export const CANONICAL_ASSISTANT_OWNERSHIP_LIMIT = 96;
const CANONICAL_OWNERSHIP_ID_LIMIT = 512;

export interface CanonicalOwnershipClaim {
  conversationId: string;
  assistantItemIds: string[];
  launchOutboxIds: string[];
  outboxEntryIds: string[];
}

export interface RuntimeCanonicalOwnership {
  /** Launch prompts can be projected again by a fresh Viewer session. */
  launchOutboxIds: string[];
  /** Recent composer entries share the outbox's own bounded history limit. */
  outboxEntryIds: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function claimIds(
  source: Record<string, unknown>,
  key: keyof Omit<CanonicalOwnershipClaim, "conversationId">,
  limit: number,
): string[] | null {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) return null;
  if (value.some((item) =>
    typeof item !== "string"
    || item.length === 0
    || item.length > CANONICAL_OWNERSHIP_ID_LIMIT
  )) return null;
  return [...new Set(value)];
}

export function parseCanonicalOwnershipClaim(value: unknown): CanonicalOwnershipClaim | null {
  const source = record(value);
  if (!source) return null;
  const allowed = new Set([
    "conversationId",
    "assistantItemIds",
    "launchOutboxIds",
    "outboxEntryIds",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key))) return null;
  const conversationId = source.conversationId;
  if (
    typeof conversationId !== "string"
    || conversationId.length === 0
    || conversationId.length > CANONICAL_OWNERSHIP_ID_LIMIT
  ) return null;
  const assistantItemIds = claimIds(
    source,
    "assistantItemIds",
    CANONICAL_ASSISTANT_OWNERSHIP_LIMIT,
  );
  const launchOutboxIds = claimIds(
    source,
    "launchOutboxIds",
    CANONICAL_LAUNCH_OWNERSHIP_LIMIT,
  );
  const outboxEntryIds = claimIds(
    source,
    "outboxEntryIds",
    CANONICAL_OUTBOX_OWNERSHIP_LIMIT,
  );
  if (!assistantItemIds || !launchOutboxIds || !outboxEntryIds) return null;
  if (!assistantItemIds.length && !launchOutboxIds.length && !outboxEntryIds.length) return null;
  return { conversationId, assistantItemIds, launchOutboxIds, outboxEntryIds };
}

function ids(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
    .slice(-limit);
}

function mergeIds(
  current: readonly string[],
  additions: unknown,
  limit: number,
): string[] {
  const next = ids(additions, limit);
  if (!next.length) return current.slice(-limit);
  const claimed = new Set(next);
  return [...current.filter((id) => !claimed.has(id)), ...next].slice(-limit);
}

export function normalizeRuntimeCanonicalOwnership(
  value: unknown,
): RuntimeCanonicalOwnership | null {
  const source = record(value);
  if (!source) return null;
  const launchOutboxIds = ids(source.launchOutboxIds, CANONICAL_LAUNCH_OWNERSHIP_LIMIT);
  const outboxEntryIds = ids(source.outboxEntryIds, CANONICAL_OUTBOX_OWNERSHIP_LIMIT);
  return launchOutboxIds.length || outboxEntryIds.length
    ? { launchOutboxIds, outboxEntryIds }
    : null;
}

export function mergeRuntimeCanonicalOwnership(
  current: RuntimeCanonicalOwnership | null | undefined,
  receipt: unknown,
): RuntimeCanonicalOwnership | null {
  const source = record(receipt);
  if (!source) return current ?? null;
  const launchOutboxIds = mergeIds(
    current?.launchOutboxIds ?? [],
    source.launchOutboxIds,
    CANONICAL_LAUNCH_OWNERSHIP_LIMIT,
  );
  const outboxEntryIds = mergeIds(
    current?.outboxEntryIds ?? [],
    source.outboxEntryIds,
    CANONICAL_OUTBOX_OWNERSHIP_LIMIT,
  );
  return launchOutboxIds.length || outboxEntryIds.length
    ? { launchOutboxIds, outboxEntryIds }
    : null;
}
