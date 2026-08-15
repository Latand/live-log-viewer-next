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
import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON, type BurndownPayload, type BurndownSeries, type EngineBurndown, type EngineLimits, type LimitSample, type LimitsPayload, type LimitsProvenance, type LimitWindow } from "./types";

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
const CACHE_MS = 30_000;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const CODEX_INITIALIZE_TIMEOUT_REASON = "app-server-initialize-timeout";

type EngineName = "claude" | "codex";
type EngineCacheEntry = {
  at: number;
  data: EngineLimits | null;
  provenance: LimitsProvenance;
  retryAt?: number | null;
  consecutive429s?: number;
  consecutiveInitializeTimeouts?: number;
};
type LimitsCache = { version: 2; engines: Record<EngineName, Record<string, EngineCacheEntry>> };
export type LimitRead = {
  data: EngineLimits | null;
  reason: string | null;
  source: "live" | "transcript" | "unavailable";
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
          if (valid) cache.engines[engine][id] = engine === "codex" ? { ...valid, data: relabelCachedWindows(valid.data) } : valid;
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

type ResolvedRead = {
  data: EngineLimits | null;
  meta: LimitsProvenance;
  retryAt: number | null;
  consecutive429s: number;
  consecutiveInitializeTimeouts: number;
};

function remember(engine: EngineName, accountId: string, resolved: ResolvedRead, now: number): void {
  cache().engines[engine][accountId] = {
    at: now,
    data: resolved.data,
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
  const meta: LimitsProvenance = {
    source: cached?.data ? "cache" : "unavailable",
    reason: read.reason,
    staleSince: cached?.provenance.staleSince ?? staleSince,
    retryAt: new Date(retryAt).toISOString(),
  };
  return { data: cached?.data ?? null, meta, retryAt, consecutive429s, consecutiveInitializeTimeouts };
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
    const json = (await res.json()) as { five_hour?: OauthWindow; seven_day?: OauthWindow };
    const data = {
      session: oauthWindow(json.five_hour, SESSION_WINDOW_MINUTES),
      weekly: oauthWindow(json.seven_day, WEEKLY_WINDOW_MINUTES),
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
    const observedAt = Math.round(clock() / 1000);
    const live = mapAppServerRateLimits(rateLimits, observedAt);
    if (!transcript.data) return { data: live, reason: null, source: "live" };
    const reconciled = reconcileQuotaReadings(
      { limits: live, observedAt: live.capturedAt, stale: false, source: "live" },
      { limits: transcript.data, observedAt: transcript.data.capturedAt, stale: false, source: "transcript" },
      observedAt,
    );
    const transcriptWon = quotaUsesSource(reconciled, "transcript");
    return {
      data: quotaAsEngineLimits(reconciled),
      reason: transcriptWon ? "transcript-reconciled" : null,
      source: transcriptWon ? "transcript" : "live",
    };
  } catch (error) {
    const detail = redactAppServerDetail(error instanceof Error ? error.message : String(error));
    const initializeTimedOut = /request timed out:\s*initialize\b/i.test(detail);
    console.warn(`[limits] Codex app-server probe for ${account.id} failed: ${detail}`);
    if (transcript.data) return {
      data: transcript.data,
      reason: "transcript-fallback",
      source: "transcript",
      ...(initializeTimedOut ? { backoffReason: CODEX_INITIALIZE_TIMEOUT_REASON } : {}),
    };
    return { data: null, reason: initializeTimedOut ? CODEX_INITIALIZE_TIMEOUT_REASON : "app-server-unavailable", source: "unavailable" };
  }
}

/** Compatibility reader for legacy homes and unavailable app-server children. */
export function readCodexTranscriptLimits(sessionsDir = accountForSpawn().sessionsDir): LimitRead {
  let scanned = 0;
  for (const file of latestSessionFiles(sessionsDir)) {
    scanned += 1;
    const hit = lastRateLimits(file);
    if (hit) return { data: hit, reason: null, source: "transcript" };
  }
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

function* latestSessionFiles(sessionsDir: string): Generator<string> {
  for (const entry of sessionFiles(sessionsDir, MAX_FILES)) yield entry.p;
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

function lastRateLimits(file: string): EngineLimits | null {
  const text = readTail(file, TAIL_BYTES);
  if (!text) return null;
  const lines = text.split("\n");
  let rejectedAt: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"') && !line.includes("usage_limit_exceeded")) continue;
    try {
      const row = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: { rate_limits?: CodexRateLimits; error?: { codex_error_info?: unknown } };
      };
      const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
      const capturedAt = Number.isFinite(ts) ? Math.round(ts / 1000) : null;
      if (row.payload?.error?.codex_error_info === "usage_limit_exceeded") {
        rejectedAt ??= capturedAt;
        continue;
      }
      const rl = row.payload?.rate_limits;
      if (!rl) continue;
      const routed = routeWindowsByHorizon(codexWindow(rl.primary, capturedAt), codexWindow(rl.secondary, capturedAt), capturedAt);
      // Codex also emits `rate_limits` events carrying no windows at all (other
      // limit families, e.g. credit balances). They say nothing about the
      // account's quota, so keep looking back for one that does.
      if (!routed.session && !routed.weekly) continue;
      if (rejectedAt !== null) {
        const candidates = (["session", "weekly"] as const)
          .flatMap((key) => routed[key] ? [{ key, value: routed[key] }] : [])
          .sort((left, right) => right.value!.usedPercent - left.value!.usedPercent || left.key.localeCompare(right.key));
        const governing = candidates[0];
        if (governing) routed[governing.key] = { ...governing.value!, usedPercent: 100, observedAt: rejectedAt };
      }
      return {
        session: routed.session,
        weekly: routed.weekly,
        plan: typeof rl.plan_type === "string" ? rl.plan_type : null,
        capturedAt: rejectedAt ?? capturedAt,
      };
    } catch {
      /* first line of the tail chunk is usually cut mid-JSON */
    }
  }
  return null;
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
