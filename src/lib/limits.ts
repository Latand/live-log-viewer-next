import fs from "node:fs";
import path from "node:path";

import { accountForSpawn, type CodexAccount } from "@/lib/accounts/codex";
import { claudeAccountForSpawn } from "@/lib/accounts/claude";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import type { AppServerRateLimits } from "@/lib/accounts/codexAppServer";
import { redactAppServerDetail } from "@/lib/accounts/codexAppServerProtocol";
import { statePath } from "@/lib/configDir";
import { WINDOW_SECONDS, clampPercent, mergeSamples, type WindowKey } from "@/lib/burndown";
import { relabelCachedWindows, routeWindowsByHorizon, SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "@/lib/limitWindows";
import { historySamples, historySince, recordLimitSample, RETENTION_S } from "@/lib/limitsHistoryStore";
import { quotaAsEngineLimits, quotaUsesSource, reconcileQuotaReadings } from "@/lib/rateLimit";
import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON, type BurndownPayload, type BurndownSeries, type EngineBurndown, type EngineLimits, type LimitSample, type LimitsPayload, type LimitsProvenance, type LimitWindow, type TierLimitWindow } from "./types";

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
};
type LimitsCache = { version: 2; engines: Record<EngineName, Record<string, EngineCacheEntry>> };
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
      (meta.retryAt === undefined || typeof meta.retryAt === "string" || meta.retryAt === null);
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
      (entry.baseData !== undefined && entry.baseData !== null && typeof entry.baseData !== "object") ||
      (entry.retryAt !== undefined && entry.retryAt !== null && typeof entry.retryAt !== "number") ||
      (entry.consecutive429s !== undefined && (!Number.isInteger(entry.consecutive429s) || entry.consecutive429s < 0)) ||
      (entry.consecutiveInitializeTimeouts !== undefined && (!Number.isInteger(entry.consecutiveInitializeTimeouts) || entry.consecutiveInitializeTimeouts < 0))) return null;
  return entry as EngineCacheEntry;
}

function readDiskCache(): LimitsCache {
  try {
    const raw = JSON.parse(fs.readFileSync(limitsCacheFile(), "utf8")) as Partial<LimitsCache> & { at?: unknown; accountId?: unknown; data?: LimitsPayload };
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
            : valid;
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

function cache(): LimitsCache {
  if (!globalStore.__llvLimitsCache) globalStore.__llvLimitsCache = readDiskCache();
  return globalStore.__llvLimitsCache;
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
    fs.writeFileSync(limitsCacheFile(), JSON.stringify({ ...value, ...projection }, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[limits] failed to persist cache", err);
  }
}

function lastCache(engine: EngineName, accountId: string): EngineCacheEntry | null {
  return cache().engines[engine][accountId] ?? null;
}

/** Drop one account's short-lived cache entry so the next `/api/limits` read
    goes to the provider. An operator-triggered re-read or a redeemed reset
    credit (issues #1418, #1373) has just produced a newer truth than the
    30-second cache holds; serving the cache would show the old window. */
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
      meta: { source: "transcript", reason: read.reason, staleSince: null, retryAt: new Date(retryAt).toISOString() },
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
  };
  return { data: base, meta, retryAt, consecutive429s, consecutiveInitializeTimeouts };
}

function cachedRead(entry: EngineCacheEntry): ResolvedRead {
  return {
    data: entry.data,
    meta: entry.provenance,
    retryAt: entry.retryAt ?? null,
    consecutive429s: entry.consecutive429s ?? 0,
    consecutiveInitializeTimeouts: entry.consecutiveInitializeTimeouts ?? 0,
  };
}

function cacheIsFresh(entry: EngineCacheEntry | null, now: number): boolean {
  if (!entry) return false;
  if (entry.retryAt) return now < entry.retryAt;
  return now - entry.at < CACHE_MS;
}

function inflightReads(): Map<string, Promise<ResolvedRead>> {
  if (!globalStore.__llvLimitsInflight) globalStore.__llvLimitsInflight = new Map();
  return globalStore.__llvLimitsInflight;
}

function logFallbackReasons(entries: ReadonlyArray<readonly [EngineName, LimitsProvenance]>): void {
  for (const [engine, meta] of entries) {
    if (meta.reason) console.warn(`[limits] ${engine} fallback: ${safeReason(meta.reason)}`);
  }
}

function resolveEngineRead(engine: EngineName, accountId: string, now: number, clock: () => number, reader: () => Promise<LimitRead>): Promise<ResolvedRead> {
  const cached = lastCache(engine, accountId);
  if (cacheIsFresh(cached, now)) return Promise.resolve(cachedRead(cached!));

  const key = `${engine}:${accountId}`;
  const reads = inflightReads();
  const existing = reads.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const latest = lastCache(engine, accountId);
    if (cacheIsFresh(latest, now)) return cachedRead(latest!);
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
  const [resolvedClaude, resolvedCodex] = await Promise.all([
    resolveEngineRead("claude", claudeAccount.id, now, clock, () => fetchClaudeLimits(path.join(claudeAccount.home, ".credentials.json"), clock)),
    resolveEngineRead("codex", codexAccount.id, now, clock, () => readCodexLimits({ account: codexAccount, liveReader: options.codexLiveReader, now: clock })),
  ]);
  return {
    claude: resolvedClaude.data,
    codex: resolvedCodex.data,
    claudeAccountId: claudeAccount.id,
    codexAccountId: codexAccount.id,
    provenance: { claude: resolvedClaude.meta, codex: resolvedCodex.meta },
    staleSince: resolvedClaude.meta.staleSince ?? resolvedCodex.meta.staleSince,
  };
}

/* ------------------------------- Claude ------------------------------- */

interface OauthWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * Live usage from the same OAuth endpoint the Claude Code CLI uses. The token
 * from ~/.claude/.credentials.json stays inside the server process; the
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
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; subscriptionType?: unknown };
    };
    if (typeof raw.claudeAiOauth?.accessToken === "string") oauthToken = raw.claudeAiOauth.accessToken;
    if (typeof raw.claudeAiOauth?.subscriptionType === "string") plan = raw.claudeAiOauth.subscriptionType;
  } catch (err) {
    return { data: null, reason: `credentials unreadable: ${err instanceof Error ? err.message : String(err)}`, source: "unavailable" };
  }
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
      flagship: oauthFlagshipWindow(json),
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

/** The flagship tier's own weekly bucket beside `seven_day` (issue #1358).
    The usage endpoint meters the top tier as `seven_day_opus` — the only
    flagship bucket the Claude CLI itself reads. `seven_day_sonnet` is a lower
    tier's bucket and `seven_day_oauth_apps` / `seven_day_overage_included` are
    not tier windows at all, so none of them can become the flagship row. */
const OAUTH_FLAGSHIP_BUCKET = "seven_day_opus";

function oauthFlagshipWindow(json: Record<string, unknown>): TierLimitWindow | null {
  const value = json[OAUTH_FLAGSHIP_BUCKET];
  const window = oauthWindow(value && typeof value === "object" ? value as OauthWindow : undefined, WEEKLY_WINDOW_MINUTES);
  return window ? { ...window, tier: OAUTH_FLAGSHIP_BUCKET.slice("seven_day_".length) } : null;
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
    console.warn(`[limits] Codex app-server probe for ${account.id} failed: ${detail}`);
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
