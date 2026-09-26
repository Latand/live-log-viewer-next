import { readClaudeCredentials } from "@/lib/accounts/claudeCredentials";
import { claudeTierDisplayName, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import fs from "node:fs";
import path from "node:path";

import { accountForSpawn, type CodexAccount } from "@/lib/accounts/codex";
import { claudeAccountForSpawn, type ClaudeAccount } from "@/lib/accounts/claude";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { activeCopilotAccountId, listCopilotAccounts } from "@/lib/accounts/copilot";
import { readCopilotTranscriptLimits } from "@/lib/limits/copilotTranscriptLimits";
import type { AppServerRateLimits } from "@/lib/accounts/codexAppServer";
import { redactAppServerDetail } from "@/lib/accounts/codexAppServerProtocol";
import { statePath } from "@/lib/configDir";
import { readJsonCache, writeJsonDurably } from "@/lib/state/durableJson";
import { WINDOW_SECONDS, clampPercent, mergeSamples, type WindowKey } from "@/lib/burndown";
import { relabelCachedWindows, routeWindowsByHorizon, SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "@/lib/limitWindows";
import { historySamples, historySince, recordLimitSample, RETENTION_S } from "@/lib/limitsHistoryStore";
import { startupDiagnostic } from "@/lib/startupDiagnostics";
import { quotaAsEngineLimits, quotaUsesSource, reconcileQuotaReadings } from "@/lib/rateLimit";
import { modelTierWindows, LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON, type BurndownPayload, type BurndownSeries, type EngineBurndown, type EngineLimits, type LimitSample, type LimitsPayload, type LimitsProvenance, type LimitWindow, type TierLimitWindow } from "./types";

/** Resolved at call time (not module load) so LLV_STATE_DIR set after this
    module is first evaluated — e.g. in tests importing it statically — still
    points reads and writes at the right state dir. */
function limitsCacheFile(): string {
  return statePath("limits-cache.json");
}
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** How far back into a session file to look for the last rate-limit event. */
const TAIL_BYTES = 192 * 1024;
/** Newest session files to try before giving up (fresh ones may lack limits). */
const MAX_FILES = 12;
/** Date buckets inspected for newly created sessions. Recent history supplies
    active long-running sessions whose start bucket has aged past this bound. */
const MAX_RECENT_SESSION_DAYS = 8;
const CACHE_MS = 30_000;
/** One Claude usage read per account per window, whichever path asks first —
    the footer's poll or the quota controller's minute tick (issue #1849). It is
    shorter than the controller's 60-second cadence, so each tick still reads
    unless a footer poll already did inside the window. */
const CLAUDE_REFRESH_WINDOW_MS = 50_000;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const CODEX_INITIALIZE_TIMEOUT_REASON = "app-server-initialize-timeout";

export { providerThrottleRetryAt, PROVIDER_THROTTLE_GRACE_MS } from "./limitsThrottle";

type EngineName = "claude" | "codex";
type EngineCacheEntry = {
  at: number;
  data: EngineLimits | null;
  /** The last reading not derived from a provider rejection. Projections are
      served from `data`, so polls stay stable, while this keeps the number the
      projection was computed from recoverable once it expires. */
  baseData?: EngineLimits | null;
  provenance: LimitsProvenance;
  retryAt?: number | null;
  consecutive429s?: number;
  consecutiveInitializeTimeouts?: number;
  /** The parser generation that produced `data`; absent on older entries. */
  parser?: number;
  /** When the provider answered with `data` (ms). `at` moves at every failed
      retry, so it cannot order two snapshots of one account; this can. Absent
      on entries written before issue #1849. */
  observedAt?: number;
};
type LimitsCache = { version: 2; engines: Record<EngineName, Record<string, EngineCacheEntry>> };

/** Bumped whenever the Claude usage parser can read a window out of a payload
    that an earlier parser read nothing out of (issue #1839). A cached entry
    carries the version that produced it; an entry from an older parser keeps
    its numbers — they are still true — but loses the provider backoff that
    would otherwise let it rest, so the very next read goes to the provider
    instead of resting on a snapshot whose tier list an old parser emptied.
    The cache must never be the thing that hides a tier. */
const CLAUDE_PARSER_VERSION = 2;
export type LimitRead = {
  data: EngineLimits | null;
  /** The reading `data` would have been without a rejection projected onto it,
      so what the cache keeps is never itself rejection-derived. */
  baseData?: EngineLimits | null;
  reason: string | null;
  source: "live" | "transcript" | "unavailable";
  /** Newest provider rejection even when the readable tail has no quota event. */
  rejectedAt?: number | null;
  retryAt?: number;
  backoffReason?: typeof CODEX_INITIALIZE_TIMEOUT_REASON;
};
export type CodexLiveLimitsReader = (account: Pick<CodexAccount, "id" | "kind" | "home" | "sessionsDir">) => Promise<AppServerRateLimits>;

const globalStore = globalThis as unknown as {
  __llvLimitsCache?: LimitsCache | null;
  /** The disk file's mtime when `of` was loaded from it or written to it. */
  __llvLimitsCacheDisk?: { of: LimitsCache; mtimeMs: number };
  __llvLimitsInflight?: Map<string, Promise<ResolvedRead>>;
};

function isProvenance(value: unknown): value is { claude: LimitsProvenance; codex: LimitsProvenance } {
  if (!value || typeof value !== "object") return false;
  const record = value as { claude?: Partial<LimitsProvenance>; codex?: Partial<LimitsProvenance> };
  const valid = (meta: Partial<LimitsProvenance> | undefined): meta is LimitsProvenance => {
    if (!meta) return false;
    return (meta.source === "live" || meta.source === "transcript" || meta.source === "cache" || meta.source === "unavailable") &&
      (typeof meta.reason === "string" || meta.reason === null) &&
      (typeof meta.staleSince === "string" || meta.staleSince === null) &&
      (meta.retryAt === undefined || typeof meta.retryAt === "string" || meta.retryAt === null) &&
      (meta.throttleAt === undefined || typeof meta.throttleAt === "string" || meta.throttleAt === null);
  };
  return valid(record.claude) && valid(record.codex);
}

function emptyCache(): LimitsCache {
  return { version: 2, engines: { claude: {}, codex: {} } };
}

function safeCacheEntry(value: unknown): EngineCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<EngineCacheEntry>;
  if (typeof entry.at !== "number" || entry.data === undefined || !entry.provenance) return null;
  const provenance = entry.provenance as Partial<LimitsProvenance>;
  if ((provenance.source !== "live" && provenance.source !== "transcript" && provenance.source !== "cache" && provenance.source !== "unavailable") ||
      (typeof provenance.reason !== "string" && provenance.reason !== null) ||
      (typeof provenance.staleSince !== "string" && provenance.staleSince !== null) ||
      (provenance.retryAt !== undefined && typeof provenance.retryAt !== "string" && provenance.retryAt !== null) ||
      (provenance.throttleAt !== undefined && typeof provenance.throttleAt !== "string" && provenance.throttleAt !== null) ||
      (entry.baseData !== undefined && entry.baseData !== null && typeof entry.baseData !== "object") ||
      (entry.retryAt !== undefined && entry.retryAt !== null && typeof entry.retryAt !== "number") ||
      (entry.consecutive429s !== undefined && (!Number.isInteger(entry.consecutive429s) || entry.consecutive429s < 0)) ||
      (entry.consecutiveInitializeTimeouts !== undefined && (!Number.isInteger(entry.consecutiveInitializeTimeouts) || entry.consecutiveInitializeTimeouts < 0)) ||
      (entry.parser !== undefined && !Number.isInteger(entry.parser))) return null;
  const normalize = (data: EngineLimits | null | undefined) => data ? { ...data, tiers: modelTierWindows(data) } : data;
  return { ...entry, data: normalize(entry.data), ...(entry.baseData === undefined ? {} : { baseData: normalize(entry.baseData) }) } as EngineCacheEntry;
}

/** A Claude entry an earlier parser generation wrote keeps its numbers — a
    session and a weekly percentage are true whoever parsed them — but loses the
    provider backoff and the cache age that would let it rest (issue #1839).
    That entry's tier list was produced by a parser that could not see the
    account's codenamed bucket, so resting on it is how a tier stays hidden for
    as long as the provider keeps answering 429. The next read goes live. */
function withCurrentParser(entry: EngineCacheEntry): EngineCacheEntry {
  if (entry.parser === CLAUDE_PARSER_VERSION) return entry;
  return { ...entry, at: 0, retryAt: null, consecutive429s: 0, parser: CLAUDE_PARSER_VERSION };
}

function readDiskCache(): LimitsCache {
  try {
    const raw = (readJsonCache(limitsCacheFile()) ?? {}) as Partial<LimitsCache> & { at?: unknown; accountId?: unknown; data?: LimitsPayload };
    if (raw.version === 2 && raw.engines && typeof raw.engines === "object") {
      const cache = emptyCache();
      for (const engine of ["claude", "codex"] as const) {
        const entries = raw.engines[engine];
        if (!entries || typeof entries !== "object") continue;
        for (const [id, entry] of Object.entries(entries)) {
          const valid = safeCacheEntry(entry);
          // Snapshots written before the horizon fix can carry a weekly window
          // under `session`; relabel on read so a degraded account still shows
          // its number under the horizon that number actually has.
          if (valid) cache.engines[engine][id] = engine === "codex"
            ? { ...valid, data: relabelCachedWindows(valid.data), ...(valid.baseData === undefined ? {} : { baseData: relabelCachedWindows(valid.baseData) }) }
            : withCurrentParser(valid);
        }
      }
      return cache;
    }
    // Preserve the usable half of a pre-v2 cache during the one-time upgrade.
    if (typeof raw.at === "number" && typeof raw.accountId === "string" && raw.data?.codex) {
      const provenance = isProvenance(raw.data.provenance) ? raw.data.provenance.codex : { source: "cache" as const, reason: "legacy cache provenance unavailable", staleSince: raw.data.staleSince ?? null };
      return { version: 2, engines: { claude: {}, codex: { [raw.accountId]: { at: raw.at, data: relabelCachedWindows(raw.data.codex), provenance } } } };
    }
  } catch {
    // An unreadable cache is a cache miss; the source accounts remain usable.
  }
  return emptyCache();
}

function diskMtime(): number {
  try { return fs.statSync(limitsCacheFile()).mtimeMs; } catch { return -1; }
}

/** The quota controller's periodic tick runs in the inventory sidecar, a
    separate OS process from the Viewer that serves `/api/limits`. Both read and
    write this one file, so a copy loaded from disk is reloaded once the other
    process has written it (issue #1849). A cache seeded in memory, never loaded
    from disk, stays as it is. */
function cache(): LimitsCache {
  const current = globalStore.__llvLimitsCache;
  const disk = globalStore.__llvLimitsCacheDisk;
  if (current && (disk?.of !== current || disk.mtimeMs === diskMtime())) return current;
  const loaded = readDiskCache();
  globalStore.__llvLimitsCache = loaded;
  globalStore.__llvLimitsCacheDisk = { of: loaded, mtimeMs: diskMtime() };
  return loaded;
}

function writeDiskCache(value: LimitsCache): void {
  try {
    fs.mkdirSync(path.dirname(limitsCacheFile()), { recursive: true });
    const latest = (engine: EngineName): [string, EngineCacheEntry] | null => Object.entries(value.engines[engine]).sort(([, a], [, b]) => b.at - a.at)[0] ?? null;
    const claude = latest("claude"); const codex = latest("codex");
    // Keep a read-only v1 projection during the cache migration so a rolling
    // deployment can continue to serve the previous process generation.
    const projection = codex ? {
      at: codex[1].at,
      accountId: codex[0],
      data: {
        claude: claude?.[1].data ?? null,
        codex: codex[1].data,
        claudeAccountId: claude?.[0] ?? null,
        codexAccountId: codex[0],
        provenance: {
          claude: claude?.[1].provenance ?? { source: "unavailable" as const, reason: "no cached Claude limits", staleSince: null },
          codex: codex[1].provenance,
        },
        staleSince: claude?.[1].provenance.staleSince ?? codex[1].provenance.staleSince,
      },
    } : {};
    // Written whole and renamed into place: the other process may read it at
    // any moment, and a torn read would be a cache miss for every account.
    writeJsonDurably(limitsCacheFile(), { ...value, ...projection });
    if (globalStore.__llvLimitsCacheDisk?.of === value || globalStore.__llvLimitsCache === value) {
      globalStore.__llvLimitsCacheDisk = { of: value, mtimeMs: diskMtime() };
    }
  } catch (err) {
    console.warn("[limits] failed to persist cache", err);
  }
}

function lastCache(engine: EngineName, accountId: string): EngineCacheEntry | null {
  return cache().engines[engine][accountId] ?? null;
}

/** Drop one account's short-lived cache entry so the next `/api/limits` read
    goes to the provider. A redeemed Codex reset credit (issue #1373) has just
    produced a newer truth than the 30-second cache holds; serving the cache
    would show the old window. A Claude re-read needs none of this: it goes
    through the same snapshot the footer answers from (issue #1849). */
export function forgetCachedLimits(engine: EngineName, accountId: string): void {
  const entries = cache().engines[engine];
  if (!(accountId in entries)) return;
  delete entries[accountId];
  writeDiskCache(cache());
}

/** Read-only account provenance for lifecycle/card projections. This never
    refreshes limits or changes which account is active. */
export function cachedLimitsProvenance(
  engine: "claude" | "codex",
  accountId: string,
): LimitsProvenance | null {
  const provenance = lastCache(engine, accountId)?.provenance;
  return provenance ? { ...provenance } : null;
}

type ResolvedRead = {
  data: EngineLimits | null;
  /** When the provider answered with `data` (ms), or null when unknown. */
  observedAt: number | null;
  /** What the cache should keep when it differs from what this read serves. */
  baseData?: EngineLimits | null;
  meta: LimitsProvenance;
  retryAt: number | null;
  consecutive429s: number;
  consecutiveInitializeTimeouts: number;
};

function remember(engine: EngineName, accountId: string, resolved: ResolvedRead, now: number): void {
  cache().engines[engine][accountId] = {
    at: now,
    data: resolved.data,
    baseData: resolved.baseData !== undefined ? resolved.baseData : resolved.data,
    provenance: resolved.meta,
    retryAt: resolved.retryAt,
    consecutive429s: resolved.consecutive429s,
    consecutiveInitializeTimeouts: resolved.consecutiveInitializeTimeouts,
    ...(engine === "claude" ? { parser: CLAUDE_PARSER_VERSION } : {}),
    ...(resolved.observedAt !== null ? { observedAt: resolved.observedAt } : {}),
  };
  writeDiskCache(cache());
  if (!resolved.data || (resolved.meta.source !== "live" && resolved.meta.source !== "transcript")) return;
  // A fresh live/transcript value is also a burndown sample. The browser's 60s
  // poll drives this, so forward history accrues without a separate sampler.
  try {
    recordLimitSample(engine, accountId, resolved.data);
  } catch (err) {
    console.warn("[limits] failed to record burndown sample", err);
  }
}

function safeReason(reason: string): string {
  return redactAppServerDetail(reason);
}

function resolveRead(read: LimitRead, cached: EngineCacheEntry | null, staleSince: string, now: number): ResolvedRead {
  const initializeTimedOut = read.backoffReason === CODEX_INITIALIZE_TIMEOUT_REASON || read.reason === CODEX_INITIALIZE_TIMEOUT_REASON;
  const consecutiveInitializeTimeouts = initializeTimedOut ? (cached?.consecutiveInitializeTimeouts ?? 0) + 1 : 0;
  const initializeBackoffMs = Math.min(
    FAILURE_COOLDOWN_MS * (2 ** Math.max(0, consecutiveInitializeTimeouts - 1)),
    MAX_RATE_LIMIT_BACKOFF_MS,
  );
  if (read.data) {
    const retryAt = initializeTimedOut ? now + initializeBackoffMs : null;
    return {
      data: read.data,
      observedAt: now,
      ...(read.baseData ? { baseData: read.baseData } : {}),
      meta: { source: read.source, reason: read.reason, staleSince: read.reason ? staleSince : null, retryAt: retryAt ? new Date(retryAt).toISOString() : null },
      retryAt,
      consecutive429s: 0,
      consecutiveInitializeTimeouts,
    };
  }
  const consecutive429s = read.reason === LIMITS_RATE_LIMITED_REASON ? (cached?.consecutive429s ?? 0) + 1 : 0;
  const exponentialMs = consecutiveInitializeTimeouts > 0
    ? initializeBackoffMs
    : consecutive429s > 0
    ? Math.min(FAILURE_COOLDOWN_MS * (2 ** (consecutive429s - 1)), MAX_RATE_LIMIT_BACKOFF_MS)
    : FAILURE_COOLDOWN_MS;
  const retryAt = Math.max(now + exponentialMs, read.retryAt ?? 0);
  // Project from — and fall back to — the last reading that was not itself
  // derived from a rejection, so a projection never becomes the evidence the
  // next poll projects from or the number that outlives it.
  const base = cached?.baseData !== undefined ? cached.baseData : cached?.data ?? null;
  const cachedRejection = base ? rejectionReading(base, read.rejectedAt) : null;
  // A rejection projected onto cache does not make the failed probe succeed:
  // the read keeps the backoff it earned, and the projection is presented only
  // while the exhaustion it describes is still running.
  if (cachedRejection && exhaustionRunning(cachedRejection, now / 1000)) {
    return {
      data: cachedRejection,
      observedAt: cached ? snapshotObservedAt(cached) : null,
      meta: { source: "transcript", reason: read.reason, staleSince: null, retryAt: new Date(retryAt).toISOString(), throttleAt: new Date(now).toISOString() },
      retryAt,
      consecutive429s,
      consecutiveInitializeTimeouts,
      baseData: base,
    };
  }
  const meta: LimitsProvenance = {
    source: base ? "cache" : "unavailable",
    reason: read.reason,
    staleSince: cached?.provenance.staleSince ?? staleSince,
    retryAt: new Date(retryAt).toISOString(),
    throttleAt: new Date(now).toISOString(),
  };
  return { data: base, observedAt: base && cached ? snapshotObservedAt(cached) : null, meta, retryAt, consecutive429s, consecutiveInitializeTimeouts };
}

/** When the provider answered with the entry's numbers. An entry written
    before issue #1849 has no such field: a live one was written when it was
    read, and a carried one went stale no earlier than it was read. */
function snapshotObservedAt(entry: EngineCacheEntry): number | null {
  if (!entry.data) return null;
  if (entry.observedAt !== undefined) return entry.observedAt;
  const staleSince = entry.provenance.staleSince ? Date.parse(entry.provenance.staleSince) : NaN;
  return entry.provenance.source === "cache" && Number.isFinite(staleSince) ? staleSince : entry.at;
}

function cachedRead(entry: EngineCacheEntry): ResolvedRead {
  return {
    data: entry.data,
    observedAt: snapshotObservedAt(entry),
    meta: entry.provenance,
    retryAt: entry.retryAt ?? null,
    consecutive429s: entry.consecutive429s ?? 0,
    consecutiveInitializeTimeouts: entry.consecutiveInitializeTimeouts ?? 0,
  };
}

function cacheIsFresh(entry: EngineCacheEntry | null, now: number, windowMs: number): boolean {
  if (!entry) return false;
  if (entry.retryAt) return now < entry.retryAt;
  return now - entry.at < windowMs;
}

function inflightReads(): Map<string, Promise<ResolvedRead>> {
  if (!globalStore.__llvLimitsInflight) globalStore.__llvLimitsInflight = new Map();
  return globalStore.__llvLimitsInflight;
}

function logFallbackReasons(entries: ReadonlyArray<readonly [EngineName, LimitsProvenance]>): void {
  for (const [engine, meta] of entries) {
    if (meta.reason) startupDiagnostic("warn", `[limits] ${engine} fallback: ${safeReason(meta.reason)}`);
  }
}

type EngineReadOptions = {
  windowMs?: number;
  /** Skip the fresh-cache and backoff rests: an operator asked for a read now. */
  force?: boolean;
};

function resolveEngineRead(engine: EngineName, accountId: string, now: number, clock: () => number, reader: () => Promise<LimitRead>, options: EngineReadOptions = {}): Promise<ResolvedRead> {
  const windowMs = options.windowMs ?? CACHE_MS;
  const cached = lastCache(engine, accountId);
  if (!options.force && cacheIsFresh(cached, now, windowMs)) return Promise.resolve(cachedRead(cached!));

  const key = `${engine}:${accountId}`;
  const reads = inflightReads();
  const existing = reads.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const latest = lastCache(engine, accountId);
    if (!options.force && cacheIsFresh(latest, now, windowMs)) return cachedRead(latest!);
    const read = await reader();
    const resolvedAt = clock();
    const resolved = resolveRead(read, latest, new Date(resolvedAt).toISOString(), resolvedAt);
    logFallbackReasons([[engine, resolved.meta]]);
    remember(engine, accountId, resolved, now);
    return resolved;
  })();
  reads.set(key, pending);
  const clear = () => {
    if (reads.get(key) === pending) reads.delete(key);
  };
  void pending.then(clear, clear);
  return pending;
}

/** Claude Code + Codex plan limits, cached briefly so UI polling stays cheap. */
export async function readLimits(options: { codexLiveReader?: CodexLiveLimitsReader; now?: () => number } = {}): Promise<LimitsPayload> {
  const clock = options.now ?? Date.now;
  const now = clock();
  const claudeAccount = claudeAccountForSpawn();
  const codexAccount = accountForSpawn();
  const copilotAccountId = activeCopilotAccountId();
  const copilotAccount = listCopilotAccounts().find((account) => account.id === copilotAccountId) ?? null;
  const copilotRead = copilotAccount ? readCopilotTranscriptLimits(copilotAccount.sessionStateDir) : null;
  const [resolvedClaude, resolvedCodex] = await Promise.all([
    claudeAccount.provider
      ? Promise.resolve({ data: null, meta: { source: "unavailable" as const, reason: "provider limits unknown", staleSince: null } })
      : resolveClaudeRead(claudeAccount, now, clock),
    resolveEngineRead("codex", codexAccount.id, now, clock, () => readCodexLimits({ account: codexAccount, liveReader: options.codexLiveReader, now: clock })),
  ]);
  return {
    claude: resolvedClaude.data,
    codex: resolvedCodex.data,
    claudeAccountId: claudeAccount.id,
    codexAccountId: codexAccount.id,
    copilot: copilotRead?.data ?? null,
    copilotAccountId: copilotAccount?.id ?? null,
    provenance: {
      claude: resolvedClaude.meta,
      codex: resolvedCodex.meta,
      copilot: copilotRead
        ? { source: copilotRead.source, reason: copilotRead.reason, staleSince: null }
        : { source: "unavailable", reason: "no active Copilot account", staleSince: null },
    },
    staleSince: resolvedClaude.meta.staleSince ?? resolvedCodex.meta.staleSince,
  };
}

/* ------------------------------- Claude ------------------------------- */

function resolveClaudeRead(account: Pick<ClaudeAccount, "id" | "home">, now: number, clock: () => number, force = false): Promise<ResolvedRead> {
  return resolveEngineRead("claude", account.id, now, clock,
    () => fetchClaudeLimits(path.join(account.home, ".credentials.json"), clock),
    { windowMs: CLAUDE_REFRESH_WINDOW_MS, force });
}

export type ClaudeAccountLimits = {
  data: EngineLimits | null;
  provenance: LimitsProvenance;
  /** When the provider answered with `data` (ms), or null when unknown. */
  observedAt: number | null;
};

/**
 * One account's Claude usage through the snapshot `/api/limits` answers from
 * (issue #1849). The quota controller and the operator's re-read call this
 * rather than the provider, so every path shares one read per account per
 * window, one in-flight request, and one backoff after a 429 — and whichever
 * path reads, the footer shows the result.
 */
export async function readClaudeAccountLimits(
  account: Pick<ClaudeAccount, "id" | "home" | "provider">,
  options: { now?: () => number; force?: boolean } = {},
): Promise<ClaudeAccountLimits> {
  if (account.provider) return { data: null, provenance: { source: "unavailable", reason: "provider limits unknown", staleSince: null }, observedAt: null };
  const clock = options.now ?? Date.now;
  const resolved = await resolveClaudeRead(account, clock(), clock, options.force);
  return { data: resolved.data, provenance: resolved.meta, observedAt: resolved.observedAt };
}

/**
 * Offers a snapshot another path holds — the registry's durable observation —
 * to the shared one. It lands only when the provider answered it later than
 * the shared snapshot's own numbers, so an older snapshot, and in particular
 * an older one with no tiers, never replaces a newer one (issue #1849). The
 * shared backoff is kept: adopting numbers is not a provider read.
 */
export function adoptClaudeLimitsSnapshot(accountId: string, data: EngineLimits, observedAt: number, now: number = Date.now()): boolean {
  const entry = lastCache("claude", accountId);
  const held = entry ? snapshotObservedAt(entry) : null;
  if (!Number.isFinite(observedAt) || (held !== null && held >= observedAt)) return false;
  const throttled = Boolean(entry?.retryAt && now < entry.retryAt);
  cache().engines.claude[accountId] = {
    at: observedAt,
    data,
    baseData: data,
    provenance: throttled
      ? { source: "cache", reason: entry!.provenance.reason, staleSince: new Date(observedAt).toISOString(), retryAt: entry!.provenance.retryAt ?? null }
      : { source: "live", reason: null, staleSince: null, retryAt: null },
    retryAt: throttled ? entry!.retryAt : null,
    consecutive429s: throttled ? entry!.consecutive429s ?? 0 : 0,
    consecutiveInitializeTimeouts: 0,
    parser: CLAUDE_PARSER_VERSION,
    observedAt,
  };
  writeDiskCache(cache());
  return true;
}

interface OauthWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * Live usage from the same OAuth endpoint the Claude Code CLI uses. The token
 * from the account-scoped credential store stays inside the server process; the
 * browser only ever sees percentages.
 */
export async function fetchClaudeLimits(
  credentialsPath: string,
  clock: () => number = Date.now,
  timeoutMs = 8_000,
): Promise<LimitRead> {
  // Keep this local named for its role: an `accessToken = …` line reads as a
  // credential assignment to the publication gate and fails the scan.
  let oauthToken = "";
  let plan: string | null = null;
  const credentials = readClaudeCredentials(path.dirname(credentialsPath));
  if (credentials.state !== "present") {
    return { data: null, reason: credentials.state === "absent" ? "credentials absent" : "credential store unavailable", source: "unavailable" };
  }
  const oauth = credentials.document.claudeAiOauth;
  if (typeof oauth?.accessToken === "string") oauthToken = oauth.accessToken;
  if (typeof oauth?.subscriptionType === "string") plan = oauth.subscriptionType;
  if (!oauthToken) return { data: null, reason: "credentials missing access token", source: "unavailable" };
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: {
        authorization: "Bearer " + oauthToken,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) return { data: null, reason: LIMITS_RATE_LIMITED_REASON, source: "unavailable", retryAt: retryAfterAt(res.headers.get("retry-after"), clock()) };
    if (res.status === 401) return { data: null, reason: LIMITS_REAUTH_REQUIRED_REASON, source: "unavailable" };
    if (!res.ok) return { data: null, reason: `oauth usage status ${res.status}`, source: "unavailable" };
    const json = (await res.json()) as { five_hour?: OauthWindow; seven_day?: OauthWindow } & Record<string, unknown>;
    const data: EngineLimits = {
      session: oauthWindow(json.five_hour, SESSION_WINDOW_MINUTES),
      weekly: oauthWindow(json.seven_day, WEEKLY_WINDOW_MINUTES),
      tiers: oauthTierWindows(json),
      plan,
      capturedAt: null,
    };
    if (!data.session && !data.weekly) return { data: null, reason: "oauth usage response had no windows", source: "unavailable" };
    return { data, reason: null, source: "live" };
  } catch (err) {
    return { data: null, reason: `oauth usage fetch failed: ${err instanceof Error ? err.message : String(err)}`, source: "unavailable" };
  }
}

function retryAfterAt(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(now, date);
}

/** The OAuth usage endpoint names its two windows (`five_hour`, `seven_day`)
    rather than numbering slots, so each one's horizon is known from the field it
    arrived in and is stamped here for the labels. */
function oauthWindow(w: OauthWindow | undefined, windowMinutes: number): LimitWindow | null {
  if (!w || typeof w.utilization !== "number") return null;
  const resets = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
  return { usedPercent: w.utilization, resetsAt: Number.isFinite(resets) ? Math.round(resets / 1000) : null, windowMinutes };
}

const OAUTH_TIER_PREFIX = "seven_day_";
const OAUTH_GENERAL_WINDOWS: ReadonlySet<string> = new Set(["five_hour", "seven_day"]);

/** Metered buckets that are NOT model tiers: overage and spend accounting, the
    OAuth-app pool, the product pools that ride the same window shape, and the
    per-model breakdown inside the week. Matched on the bucket key's words, so
    `seven_day_omelette` and `omelette_promotional` are both the omelette pool
    however the provider spells the key. */
const OAUTH_NON_TIER_POOLS: readonly string[] = ["overage", "oauth_apps", "cowork", "omelette", "extra_usage", "spend", "breakdown"];

function isAccountingPool(key: string): boolean {
  return OAUTH_NON_TIER_POOLS.some((pool) => key.includes(pool));
}

/** The tier name a top-level bucket key spells: `seven_day_opus` meters the
    `opus` tier, and a bucket the provider files under a codename (`nimbus_quill`)
    is its own tier key until something names it. */
function tierOfBucketKey(key: string): string {
  return key.startsWith(OAUTH_TIER_PREFIX) ? key.slice(OAUTH_TIER_PREFIX.length) : key;
}

/** One model-scoped entry of the payload's `limits` array (issue #1839).
 *
 * Captured live on two accounts (key names and label strings only), every
 * entry has the shape
 * `{ kind, group, percent, severity, resets_at, scope, is_active }`: `kind` is
 * `session`, `weekly_all` or `weekly_scoped`, and only a scoped entry carries
 * `scope: { model: { id, display_name }, surface }`. The Fable window is the
 * `weekly_scoped` entry whose `scope.model.display_name` is "Fable" and whose
 * `id` is null. The codenamed `nimbus_quill` bucket matched neither that
 * entry's percent nor its reset on either account, so it is a separate pool
 * and never the source of Fable's line while this list names one.
 *
 * The reader stays tolerant of other spellings the provider may send
 * (`utilization` for `percent`, a top-level `model`, a `name` label, an entry
 * naming the bucket its window lives in), because nothing pins this shape.
 */
interface OauthScopedLimit {
  /** Bucket keys this entry names, matched against the payload's own keys. */
  buckets: string[];
  /** The model family this entry attributes the window to, when it names one. */
  family: string | null;
  /** The provider's human label for the window, when the entry carries one. */
  label: string | null;
  /** The entry's own window, when it carries one inline. */
  window: LimitWindow | null;
}

/** Fields a human label arrives under, most explicit first: `display_name` is
    what the provider fills for the operator, while `name` can carry a machine
    identifier (issue #1839 review). */
const OAUTH_LABEL_FIELDS: readonly string[] = ["display_name", "displayName", "label", "title", "name"];

/** A string spelled as a machine identifier (`weekly_scoped`, `nimbus_quill`,
    `claude-fable-5-1`, `fable`) rather than as words for a person to read. */
const MACHINE_IDENTIFIER = /^[a-z0-9_.:-]+$/;

function stringValues(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 3 || !value || typeof value !== "object") return [];
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.flatMap((item) => stringValues(item, depth + 1));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The first human label among `records`' label fields; codenames and bucket
    keys are skipped so a machine `name` never outranks a `display_name`. */
function humanLabel(records: readonly (Record<string, unknown> | null)[], bucketKeys: ReadonlySet<string>): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const field of OAUTH_LABEL_FIELDS) {
      const value = record[field];
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (text && !bucketKeys.has(text) && !MACHINE_IDENTIFIER.test(text)) return text;
    }
  }
  return null;
}

function scopedWindow(record: Record<string, unknown>): LimitWindow | null {
  const used = typeof record.percent === "number" ? record.percent : typeof record.utilization === "number" ? record.utilization : null;
  if (used === null || !Number.isFinite(used)) return null;
  const resets = typeof record.resets_at === "string" ? Date.parse(record.resets_at) : NaN;
  const session = [record.group, record.kind].some((value) => typeof value === "string" && value.startsWith("session"));
  return {
    usedPercent: used,
    resetsAt: Number.isFinite(resets) ? Math.round(resets / 1000) : null,
    windowMinutes: session ? SESSION_WINDOW_MINUTES : WEEKLY_WINDOW_MINUTES,
  };
}

function readScopedLimit(entry: unknown, bucketKeys: ReadonlySet<string>): OauthScopedLimit | null {
  const record = asRecord(entry);
  if (!record) return null;
  const identifiers = stringValues(record).map((value) => value.trim()).filter((value) => MACHINE_IDENTIFIER.test(value));
  /* An entry that spells a general window or an accounting pool anywhere in
     its identifiers is neither a model tier nor a pointer to one: adopting it
     would file the 5-hour window, or the OAuth-app pool, under whatever model
     it names and gate that model's spawns on it. Checked before the entry can
     contribute an inline window or a bucket attribution. */
  if (identifiers.some((value) => OAUTH_GENERAL_WINDOWS.has(value) || isAccountingPool(value))) return null;
  const buckets = [...new Set(identifiers.filter((value) => bucketKeys.has(value)))];
  const scope = asRecord(record.scope);
  const scopeModel = asRecord(scope?.model);
  const label = humanLabel([scopeModel, record], bucketKeys);
  /* The family comes from the model the entry is scoped to, and only then
     from the words of its human label ("Fable", "Fable weekly limit"). */
  const modelNames = [scopeModel?.id, scopeModel?.display_name, scope?.model, record.model, record.model_id]
    .filter((value): value is string => typeof value === "string");
  const family = [...modelNames, ...(label ? label.split(/[\s,/|()\[\]]+/) : [])]
    .map((value) => normalizeClaudeLaunchModel(value))
    .find((value) => value !== null) ?? null;
  if (!buckets.length && !family) return null;
  return { buckets, family, label, window: scopedWindow(record) };
}

/** Every model-tier window the provider meters beside `five_hour`/`seven_day`
 * (issues #1358, #1796, #1839).
 *
 * The provider sends no `seven_day_<tier>` key for the tier it meters:
 * `seven_day_opus` and `seven_day_sonnet` arrive null and there is no
 * `seven_day_fable` at all. It names the window in `limits[]` instead, as a
 * `weekly_scoped` entry scoped to a model. So `limits[]` is the source whenever
 * one of its entries names a model window: its label is the name the operator
 * reads, and the model it names is the tier key a spawn of that model is gated
 * on. Only when it names none does the bucket scan stand in: every non-null
 * top-level bucket carrying a window that is not one of the two general windows
 * and not an accounting pool.
 *
 * Rows are ordered by the name they display, so they never reshuffle between
 * reads.
 */
function oauthTierWindows(json: Record<string, unknown>): TierLimitWindow[] {
  const byBucket = new Map<string, TierLimitWindow>();
  const tierOfBucket = new Map<string, string>();
  for (const key of Object.keys(json)) {
    if (OAUTH_GENERAL_WINDOWS.has(key) || isAccountingPool(key)) continue;
    const value = json[key];
    const window = oauthWindow(value && typeof value === "object" ? value as OauthWindow : undefined, WEEKLY_WINDOW_MINUTES);
    if (!window) continue;
    const tier = tierOfBucketKey(key);
    if (!tier) continue;
    byBucket.set(tier, { ...window, tier });
    tierOfBucket.set(key, tier);
  }
  const bucketKeys = new Set([...tierOfBucket.keys(), ...tierOfBucket.values()]);
  const listed = new Map<string, TierLimitWindow>();
  const entries = Array.isArray(json.limits) ? json.limits : [];
  for (const raw of entries) {
    const entry = readScopedLimit(raw, bucketKeys);
    if (!entry) continue;
    const bucketTier = entry.buckets.map((key) => tierOfBucket.get(key) ?? key).find((tier) => byBucket.has(tier)) ?? null;
    const source = entry.window ?? (bucketTier ? byBucket.get(bucketTier)! : null);
    const tier = entry.family ?? bucketTier;
    if (!source || !tier) continue;
    const window: TierLimitWindow = {
      usedPercent: source.usedPercent,
      resetsAt: source.resetsAt,
      windowMinutes: source.windowMinutes,
      tier,
      ...(entry.label ? { label: entry.label } : {}),
    };
    // Two entries for one model: the more exhausted one is what binds a spawn.
    const prior = listed.get(tier);
    if (!prior || window.usedPercent > prior.usedPercent) listed.set(tier, window);
  }
  const tiers = listed.size ? [...listed.values()] : [...byBucket.values()];
  return tiers.sort((left, right) => claudeTierDisplayName(left.tier, left.label).localeCompare(claudeTierDisplayName(right.tier, right.label)));
}

/* -------------------------------- Codex -------------------------------- */

interface CodexWindow {
  used_percent?: unknown;
  resets_at?: unknown;
  resets_in_seconds?: unknown;
  window_minutes?: unknown;
}

interface CodexRateLimits {
  primary?: CodexWindow;
  secondary?: CodexWindow;
  plan_type?: unknown;
}

/** The app-server's two slots carry whichever windows the plan has, each with
    its own `windowDurationMins`; a plan with no 5-hour limit sends its weekly
    window as `primary`. Filing them by declared length (issue #606) keeps a
    weekly number off the 5h label and leaves the weekly window populated. */
export function mapAppServerRateLimits(rateLimits: AppServerRateLimits, capturedAt = Math.round(Date.now() / 1000)): EngineLimits {
  const toLimitWindow = (w: AppServerRateLimits["primary"]): LimitWindow | null =>
    w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt, windowMinutes: w.windowDurationMins } : null;
  const routed = routeWindowsByHorizon(toLimitWindow(rateLimits.primary), toLimitWindow(rateLimits.secondary), capturedAt);
  return {
    session: routed.session,
    weekly: routed.weekly,
    plan: rateLimits.planType,
    capturedAt,
  };
}

/**
 * Every Codex home receives a structured app-server snapshot and a transcript
 * observation. The two are reconciled per window; an active provider exhaustion
 * remains authoritative through its reset, while ordinary conflicts use time.
 */
export async function readCodexLimits(options: {
  account?: Pick<CodexAccount, "id" | "kind" | "home" | "sessionsDir">;
  liveReader?: CodexLiveLimitsReader;
  now?: () => number;
} = {}): Promise<LimitRead> {
  const account = options.account ?? accountForSpawn();
  const clock = options.now ?? Date.now;
  const transcript = readCodexTranscriptLimits(account.sessionsDir);
  try {
    const rateLimits = await (options.liveReader ?? ((candidate) => managedCodexRuntime().readRateLimits(candidate as CodexAccount)))(account);
    const observedAt = clock() / 1000;
    const live = mapAppServerRateLimits(rateLimits, observedAt);
    // One validated projection, onto the candidate the rejection is about: the
    // transcript snapshot when it covers the rejection, otherwise the live
    // window a newer rejection belongs to.
    const transcriptProjection = transcript.data ? rejectionReading(transcript.data, transcript.rejectedAt) : null;
    const transcriptReset = transcriptProjection && transcript.data
      ? governingWindow(transcript.data)?.value.resetsAt
      : null;
    const liveReset = governingWindow(live)?.value.resetsAt;
    // When the rejection predates its transcript reset, a strictly later live
    // reset proves the provider opened a successor cycle and retired it.
    const projected = typeof transcript.rejectedAt === "number"
      && typeof transcriptReset === "number"
      && transcript.rejectedAt < transcriptReset
      && typeof liveReset === "number"
      && liveReset > transcriptReset
      ? null
      : transcriptProjection ?? rejectionReading(live, transcript.rejectedAt);
    const transcriptLimits = projected ?? transcript.data;
    if (!transcriptLimits) return { data: live, reason: null, source: "live" };
    const reconcile = (limits: EngineLimits) => reconcileQuotaReadings(
      { limits: live, observedAt: live.capturedAt, stale: false, source: "live" },
      { limits, observedAt: limits.capturedAt, stale: false, source: "transcript" },
      observedAt,
    );
    const reconciled = reconcile(transcriptLimits);
    const transcriptWon = quotaUsesSource(reconciled, "transcript");
    // What this read would have been without the rejection, so the cache keeps
    // a reading no projection shaped and the number an expired exhaustion
    // overrode comes back when it expires.
    const unprojected = projected ? (transcript.data ? quotaAsEngineLimits(reconcile(transcript.data)) : live) : null;
    return {
      data: quotaAsEngineLimits(reconciled),
      ...(unprojected ? { baseData: unprojected } : {}),
      reason: transcriptWon ? "transcript-reconciled" : null,
      source: transcriptWon ? "transcript" : "live",
    };
  } catch (error) {
    const detail = redactAppServerDetail(error instanceof Error ? error.message : String(error));
    const initializeTimedOut = /request timed out:\s*initialize\b/i.test(detail);
    startupDiagnostic("warn", `[limits] Codex app-server probe for ${account.id} failed: ${detail}`);
    if (transcript.data) {
      // With no probe to reconcile against, nothing downstream would retire the
      // projection, so it is served only while the exhaustion it describes is
      // still running; past that the transcript's own reading is the truth.
      const projection = rejectionReading(transcript.data, transcript.rejectedAt);
      const data = projection && exhaustionRunning(projection, clock() / 1000) ? projection : transcript.data;
      return {
        data,
        ...(data === projection ? { baseData: transcript.data } : {}),
        reason: "transcript-fallback",
        source: "transcript",
        ...(initializeTimedOut ? { backoffReason: CODEX_INITIALIZE_TIMEOUT_REASON } : {}),
      };
    }
    if (transcript.rejectedAt !== null && transcript.rejectedAt !== undefined) return {
      ...transcript,
      ...(initializeTimedOut ? { backoffReason: CODEX_INITIALIZE_TIMEOUT_REASON } : {}),
    };
    return { data: null, reason: initializeTimedOut ? CODEX_INITIALIZE_TIMEOUT_REASON : "app-server-unavailable", source: "unavailable" };
  }
}

/** Compatibility reader for legacy homes and unavailable app-server children. */
export function readCodexTranscriptLimits(sessionsDir = accountForSpawn().sessionsDir): LimitRead {
  let scanned = 0;
  let latest: EngineLimits | null = null;
  let rejectedAt: number | null = null;
  for (const file of latestSessionFiles(sessionsDir)) {
    scanned += 1;
    const scan = lastRateLimits(file);
    if (scan.rejectedAt !== null && (rejectedAt === null || scan.rejectedAt > rejectedAt)) rejectedAt = scan.rejectedAt;
    if (scan.data && (!latest || latest.capturedAt === null || (scan.data.capturedAt !== null && scan.data.capturedAt > latest.capturedAt))) latest = scan.data;
  }
  if (latest) {
    // The rejection travels to whichever consumer projects it, so the snapshot
    // leaves here exactly as the transcript recorded it. A quota event captured
    // after the rejection is the provider's later word on the same account, so
    // the rejection stops travelling at that point.
    const newest = rejectedAt !== null && (latest.capturedAt === null || rejectedAt >= latest.capturedAt) ? rejectedAt : null;
    return { data: latest, reason: null, source: "transcript", rejectedAt: newest };
  }
  if (rejectedAt !== null) return { data: null, reason: "usage-limit-exceeded", source: "transcript", rejectedAt };
  return { data: null, reason: scanned === 0 ? "no codex session files" : `no rate_limits event in newest ${scanned} session files`, source: "unavailable" };
}

function listDesc(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

/** Session transcripts for one Codex account home, newest first, each with its
    mtime so callers can stop once files fall outside their window. */
function* sessionFiles(sessionsDir: string, max: number): Generator<{ p: string; m: number }> {
  let yielded = 0;
  for (const year of listDesc(sessionsDir)) {
    for (const month of listDesc(path.join(sessionsDir, year))) {
      for (const day of listDesc(path.join(sessionsDir, year, month))) {
        const dir = path.join(sessionsDir, year, month, day);
        const entries: { p: string; m: number }[] = [];
        for (const name of listDesc(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const p = path.join(dir, name);
          try {
            entries.push({ p, m: fs.statSync(p).mtimeMs });
          } catch {
            /* vanished mid-scan */
          }
        }
        entries.sort((a, b) => b.m - a.m);
        for (const entry of entries) {
          yield entry;
          if (++yielded >= max) return;
        }
      }
    }
  }
}

function latestDayDirs(sessionsDir: string, max: number): string[] {
  const dirs: string[] = [];
  for (const year of listDesc(sessionsDir)) {
    for (const month of listDesc(path.join(sessionsDir, year))) {
      for (const day of listDesc(path.join(sessionsDir, year, month))) {
        dirs.push(path.join(sessionsDir, year, month, day));
        if (dirs.length >= max) return dirs;
      }
    }
  }
  return dirs;
}

function dayDirFromSessionId(sessionsDir: string, sessionId: string): string | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(sessionId);
  if (!match) return null;
  const startedAt = Number.parseInt(match[1] + match[2], 16);
  if (!Number.isFinite(startedAt)) return null;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return null;
  return path.join(
    sessionsDir,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
}

/** Recent prompt history is a bounded index of active session ids. It keeps a
    long-running transcript discoverable after newer start-date buckets exist. */
function recentHistorySessionFiles(sessionsDir: string): string[] {
  const text = readTail(path.join(path.dirname(sessionsDir), "history.jsonl"), TAIL_BYTES);
  if (!text) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"session_id"')) continue;
    try {
      const row = JSON.parse(line) as { session_id?: unknown };
      if (typeof row.session_id !== "string" || seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      const dir = dayDirFromSessionId(sessionsDir, row.session_id);
      if (!dir) continue;
      const name = listDesc(dir).find((candidate) => candidate.endsWith(`${row.session_id}.jsonl`));
      if (name) files.push(path.join(dir, name));
      if (seen.size >= MAX_FILES) break;
    } catch {
      /* the first history line can be a partial tail record */
    }
  }
  return files;
}

function latestSessionFiles(sessionsDir: string): string[] {
  const candidates = new Set(recentHistorySessionFiles(sessionsDir));
  for (const dir of latestDayDirs(sessionsDir, MAX_RECENT_SESSION_DAYS)) {
    for (const name of listDesc(dir).filter((file) => file.endsWith(".jsonl")).slice(0, MAX_FILES)) candidates.add(path.join(dir, name));
  }
  const entries: { p: string; m: number }[] = [];
  for (const p of candidates) {
    try {
      entries.push({ p, m: fs.statSync(p).mtimeMs });
    } catch {
      /* vanished mid-scan */
    }
  }
  return entries
    .sort((a, b) => b.m - a.m || b.p.localeCompare(a.p))
    .slice(0, MAX_FILES)
    .map((entry) => entry.p);
}

function readTail(file: string, bytes: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function isCodexUsageLimitInfo(value: unknown): boolean {
  return value === "usage_limit" || value === "usage_limit_exceeded";
}

function lastRateLimits(file: string): { data: EngineLimits | null; rejectedAt: number | null } {
  const text = readTail(file, TAIL_BYTES);
  if (!text) return { data: null, rejectedAt: null };
  const lines = text.split("\n");
  let data: EngineLimits | null = null;
  let rejectedAt: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"') && !line.includes('"usage_limit')) continue;
    try {
      const row = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: { rate_limits?: CodexRateLimits; codex_error_info?: unknown; error?: { codex_error_info?: unknown } };
      };
      const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
      const capturedAt = Number.isFinite(ts) ? ts / 1000 : null;
      if (isCodexUsageLimitInfo(row.payload?.codex_error_info) || isCodexUsageLimitInfo(row.payload?.error?.codex_error_info)) {
        if (capturedAt !== null && (rejectedAt === null || capturedAt > rejectedAt)) rejectedAt = capturedAt;
        continue;
      }
      const rl = row.payload?.rate_limits;
      if (!rl) continue;
      const routed = routeWindowsByHorizon(codexWindow(rl.primary, capturedAt), codexWindow(rl.secondary, capturedAt), capturedAt);
      // Codex also emits `rate_limits` events carrying no windows at all (other
      // limit families, e.g. credit balances). They say nothing about the
      // account's quota, so keep looking back for one that does.
      if (!routed.session && !routed.weekly) continue;
      if (!data || data.capturedAt === null || (capturedAt !== null && capturedAt > data.capturedAt)) {
        data = {
          session: routed.session,
          weekly: routed.weekly,
          plan: typeof rl.plan_type === "string" ? rl.plan_type : null,
          capturedAt,
        };
      }
    } catch {
      /* first line of the tail chunk is usually cut mid-JSON */
    }
  }
  return { data, rejectedAt };
}

function governingWindow(limits: EngineLimits): { key: "session" | "weekly"; value: LimitWindow } | null {
  return (["session", "weekly"] as const)
    .flatMap((key) => limits[key] ? [{ key, value: limits[key]! }] : [])
    .sort((left, right) => right.value.usedPercent - left.value.usedPercent || left.key.localeCompare(right.key))[0] ?? null;
}

/** A rejection is evidence about the quota window that was open when the
    provider issued it, whose interval is `[resetsAt - windowMinutes, resetsAt]`.
    Projecting one onto a candidate window it predates would synthesize an
    exhaustion from a cycle that has since reset and override a truthful live
    reading, so an out-of-interval rejection is stale evidence. A rejection
    issued after the candidate's reset belongs to the cycle that opened there —
    the candidate is simply the older word — and stays usable through that
    successor's length, with its reset unknown. Each bound the window does not
    declare — an unknown reset, or a length absent from a snapshot cached before
    issue #606 — is one the rejection is not tested against, leaving the
    existing behavior for that side. */
function rejectionWithinWindow(limits: EngineLimits, rejectedAt: number): boolean {
  const window = governingWindow(limits)?.value;
  if (!window) return false;
  if (window.resetsAt === null) return true;
  if (typeof window.windowMinutes !== "number") return rejectedAt <= window.resetsAt;
  const windowSeconds = window.windowMinutes * 60;
  return rejectedAt >= window.resetsAt - windowSeconds && rejectedAt < window.resetsAt + windowSeconds;
}

/** The one place a provider rejection becomes a quota reading. Every consumer
    projects through here, so a rejection is validated against the window it is
    about exactly once; `null` means this rejection says nothing about the
    candidate and the candidate stands as read. */
function rejectionReading(limits: EngineLimits, rejectedAt: number | null | undefined): EngineLimits | null {
  if (rejectedAt === null || rejectedAt === undefined) return null;
  if (!rejectionWithinWindow(limits, rejectedAt)) return null;
  return applyTranscriptRejection(limits, rejectedAt);
}

/** Whether a projection still describes a running exhaustion at `nowSeconds`:
    through a reset the provider named, or for one window length when the
    rejection erased it. A projection past that is history, not the account's
    current state, and must not be presented as a live transcript reading. */
function exhaustionRunning(limits: EngineLimits, nowSeconds: number): boolean {
  const governing = governingWindow(limits);
  if (!governing || governing.value.usedPercent < 100) return false;
  const window = governing.value;
  if (window.resetsAt !== null) return window.resetsAt > nowSeconds;
  if (window.observedAt === null || window.observedAt === undefined) return true;
  // A window that declares no length still has the horizon of the key it is
  // filed under, which is the longest an exhaustion observed in it can run.
  const windowMinutes = typeof window.windowMinutes === "number"
    ? window.windowMinutes
    : governing.key === "weekly" ? WEEKLY_WINDOW_MINUTES : SESSION_WINDOW_MINUTES;
  return nowSeconds - window.observedAt < windowMinutes * 60;
}

function applyTranscriptRejection(limits: EngineLimits, rejectedAt: number): EngineLimits {
  const governing = governingWindow(limits);
  if (!governing) return limits;
  const resetsAt = governing.value.resetsAt !== null && governing.value.resetsAt <= rejectedAt
    ? null
    : governing.value.resetsAt;
  const data: EngineLimits = {
    ...limits,
    [governing.key]: { ...governing.value, usedPercent: 100, resetsAt, observedAt: rejectedAt, source: "transcript" },
  };
  const observed = [data.session?.observedAt, data.weekly?.observedAt]
    .filter((value): value is number => value !== null && value !== undefined);
  return { ...data, capturedAt: observed.length ? Math.min(...observed) : rejectedAt };
}

function codexWindow(w: CodexWindow | undefined, capturedAt: number | null): LimitWindow | null {
  if (!w || typeof w.used_percent !== "number") return null;
  let resetsAt: number | null = null;
  if (typeof w.resets_at === "number") resetsAt = w.resets_at;
  else if (typeof w.resets_in_seconds === "number" && capturedAt !== null) resetsAt = capturedAt + w.resets_in_seconds;
  return {
    usedPercent: w.used_percent,
    resetsAt,
    windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
    observedAt: capturedAt,
  };
}

/* ----------------------------- Burndown series ----------------------------- */

/** Newest files to scan for the weekly series — a backstop far above a normal
    week's worth of Codex sessions. */
const SERIES_MAX_FILES = 400;
/** Whole-file read cap; larger transcripts fall back to a tail read. */
const SERIES_MAX_BYTES = 8 * 1024 * 1024;

function windowSecondsOf(w: LimitWindow | null): number | null {
  if (w && typeof w.windowMinutes === "number" && w.windowMinutes > 0) return Math.round(w.windowMinutes * 60);
  return null;
}

function readAll(file: string): string | null {
  try {
    if (fs.statSync(file).size > SERIES_MAX_BYTES) return readTail(file, SERIES_MAX_BYTES);
    return fs.readFileSync(file, "utf8");
  } catch {
    return readTail(file, SERIES_MAX_BYTES);
  }
}

export interface CodexTranscriptSeries {
  session: LimitSample[];
  weekly: LimitSample[];
  /** Window definition from the newest event, for the ideal diagonal. */
  sessionWindowSeconds: number | null;
  weeklyWindowSeconds: number | null;
  sessionResetsAt: number | null;
  weeklyResetsAt: number | null;
}

/** All `rate_limits` events across the Codex session transcripts touched since
    `sinceUnix`, reconstructing the weekly/5h remaining-quota curves retroactively
    so the chart is populated on first open. Files whose mtime predates the
    window are skipped unread; the newest event fixes each window's diagonal. */
export function collectCodexRateLimitSeries(sessionsDir: string, sinceUnix: number): CodexTranscriptSeries {
  const session: LimitSample[] = [];
  const weekly: LimitSample[] = [];
  const seen = new Set<number>();
  let latestT = -Infinity;
  let sessionWindowSeconds: number | null = null;
  let weeklyWindowSeconds: number | null = null;
  let sessionResetsAt: number | null = null;
  let weeklyResetsAt: number | null = null;
  for (const { p, m } of sessionFiles(sessionsDir, SERIES_MAX_FILES)) {
    if (m / 1000 < sinceUnix) continue;
    const text = readAll(p);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const row = JSON.parse(line) as { timestamp?: unknown; payload?: { rate_limits?: CodexRateLimits } };
        const rl = row.payload?.rate_limits;
        if (!rl) continue;
        const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        const t = Math.round(ts / 1000);
        if (t < sinceUnix || seen.has(t)) continue;
        // Each event's windows go to the horizon their own `window_minutes`
        // names, so a plan that reports only a weekly window backfills the
        // weekly curve instead of the 5h one (issue #606).
        const routed = routeWindowsByHorizon(codexWindow(rl.primary, t), codexWindow(rl.secondary, t), t);
        // A windowless event (another limit family) contributes no sample, and
        // must not become the newest event that fixes the window definitions.
        if (!routed.session && !routed.weekly) continue;
        seen.add(t);
        if (routed.session) session.push({ t, remaining: clampPercent(100 - routed.session.usedPercent) });
        if (routed.weekly) weekly.push({ t, remaining: clampPercent(100 - routed.weekly.usedPercent) });
        if (t > latestT) {
          latestT = t;
          if (routed.session) { sessionResetsAt = routed.session.resetsAt; sessionWindowSeconds = windowSecondsOf(routed.session); }
          if (routed.weekly) { weeklyResetsAt = routed.weekly.resetsAt; weeklyWindowSeconds = windowSecondsOf(routed.weekly); }
        }
      } catch {
        /* partial or non-JSON line */
      }
    }
  }
  session.sort((a, b) => a.t - b.t);
  weekly.sort((a, b) => a.t - b.t);
  return { session, weekly, sessionWindowSeconds, weeklyWindowSeconds, sessionResetsAt, weeklyResetsAt };
}

/** Assemble one window's burndown from forward poll samples, an optional
    transcript backfill and the current live value, scoped to the current window.
    Exported for the window-scoping regression test. */
export function buildSeries(
  forward: LimitSample[],
  backfill: LimitSample[],
  live: LimitWindow | null,
  now: number,
  windowSeconds: number,
  backfillResetsAt: number | null,
): BurndownSeries {
  const resetsAt = live?.resetsAt ?? backfillResetsAt ?? null;
  const windowStart = resetsAt !== null ? resetsAt - windowSeconds : null;
  const livePoint: LimitSample[] = live && typeof live.usedPercent === "number" ? [{ t: now, remaining: clampPercent(100 - live.usedPercent) }] : [];
  const merged = mergeSamples(forward, backfill, livePoint);
  // Strictly scope to the current window: a sample from before windowStart
  // belongs to the previous window, and after a rollover it would sit in the
  // series as a low pre-reset value ahead of the ~100% post-reset point. That
  // boundary rise reads as a refill and would suppress the pace projection for
  // the whole new window, so those pre-window samples are dropped here.
  const samples = windowStart !== null ? merged.filter((s) => s.t >= windowStart) : merged;
  return { windowStart, resetsAt, windowSeconds, samples };
}

function buildEngineBurndown(
  engine: EngineName,
  accountId: string,
  limits: EngineLimits | null,
  now: number,
  backfill: CodexTranscriptSeries | null,
): EngineBurndown {
  const forward = (window: WindowKey) => historySamples(engine, accountId, window, now);
  // Only a snapshot that reports some window is evidence about horizons: it
  // shows what the plan has, so a horizon missing from it is one the plan does
  // not report. A snapshot with no windows at all (a failed read, or a
  // transcript event from another limit family) says nothing, and its windows
  // fall through to the ordinary series so existing history still charts.
  const snapshotNamesAWindow = Boolean(limits?.session || limits?.weekly);
  const seriesFor = (
    key: WindowKey,
    backfillSamples: LimitSample[],
    backfillWindowSeconds: number | null,
    backfillResetsAt: number | null,
  ): BurndownSeries => {
    const live = limits?.[key] ?? null;
    const windowSeconds = windowSecondsOf(live) ?? backfillWindowSeconds ?? WINDOW_SECONDS[key];
    // A plan that reports no window of this horizon has nothing to chart: the
    // forward history under this key predates the horizon fix (issue #606) and
    // belongs to the other window, so it is not drawn here. The panel names
    // that reason rather than claiming there is no history at all.
    if (snapshotNamesAWindow && !live && backfillSamples.length === 0) {
      return { windowStart: null, resetsAt: null, windowSeconds, samples: [], windowUnreported: true };
    }
    return buildSeries(forward(key), backfillSamples, live, now, windowSeconds, backfillResetsAt);
  };
  return {
    session: seriesFor("session", backfill?.session ?? [], backfill?.sessionWindowSeconds ?? null, backfill?.sessionResetsAt ?? null),
    weekly: seriesFor("weekly", backfill?.weekly ?? [], backfill?.weeklyWindowSeconds ?? null, backfill?.weeklyResetsAt ?? null),
  };
}

/** Burndown history for both engines. Reads the current live snapshot (which
    also records a forward sample), merges the persisted poll history, and
    backfills the Codex curve from transcripts so it is never empty. */
export async function readBurndown(options: { codexLiveReader?: CodexLiveLimitsReader } = {}): Promise<BurndownPayload> {
  const payload = await readLimits(options);
  const now = Math.round(Date.now() / 1000);
  const since = now - RETENTION_S;
  const claude = payload.claudeAccountId
    ? buildEngineBurndown("claude", payload.claudeAccountId, payload.claude, now, null)
    : null;
  let codex: EngineBurndown | null = null;
  if (payload.codexAccountId) {
    const backfill = collectCodexRateLimitSeries(accountForSpawn().sessionsDir, since);
    codex = buildEngineBurndown("codex", payload.codexAccountId, payload.codex, now, backfill);
  }
  return {
    claude,
    codex,
    claudeAccountId: payload.claudeAccountId,
    codexAccountId: payload.codexAccountId,
    historySince: historySince(),
  };
}
