import fs from "node:fs";
import path from "node:path";

import { accountForSpawn, type CodexAccount } from "@/lib/accounts/codex";
import { claudeAccountForSpawn } from "@/lib/accounts/claude";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import type { AppServerRateLimits } from "@/lib/accounts/codexAppServer";
import { statePath } from "@/lib/configDir";
import type { EngineLimits, LimitsPayload, LimitsProvenance, LimitWindow } from "./types";

const LIMITS_CACHE_FILE = statePath("limits-cache.json");
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** How far back into a session file to look for the last rate-limit event. */
const TAIL_BYTES = 192 * 1024;
/** Newest session files to try before giving up (fresh ones may lack limits). */
const MAX_FILES = 12;
const CACHE_MS = 30_000;

type EngineName = "claude" | "codex";
type EngineCacheEntry = { at: number; data: EngineLimits; provenance: LimitsProvenance };
type LimitsCache = { version: 2; engines: Record<EngineName, Record<string, EngineCacheEntry>> };
export type LimitRead = { data: EngineLimits | null; reason: string | null; source: "live" | "transcript" | "unavailable" };
export type CodexLiveLimitsReader = (account: Pick<CodexAccount, "id" | "kind" | "home" | "sessionsDir">) => Promise<AppServerRateLimits>;

const globalStore = globalThis as unknown as {
  __llvLimitsCache?: LimitsCache | null;
};

function isProvenance(value: unknown): value is { claude: LimitsProvenance; codex: LimitsProvenance } {
  if (!value || typeof value !== "object") return false;
  const record = value as { claude?: Partial<LimitsProvenance>; codex?: Partial<LimitsProvenance> };
  const valid = (meta: Partial<LimitsProvenance> | undefined): meta is LimitsProvenance => {
    if (!meta) return false;
    return (meta.source === "live" || meta.source === "transcript" || meta.source === "cache" || meta.source === "unavailable") &&
      (typeof meta.reason === "string" || meta.reason === null) &&
      (typeof meta.staleSince === "string" || meta.staleSince === null);
  };
  return valid(record.claude) && valid(record.codex);
}

function emptyCache(): LimitsCache {
  return { version: 2, engines: { claude: {}, codex: {} } };
}

function safeCacheEntry(value: unknown): EngineCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<EngineCacheEntry>;
  if (typeof entry.at !== "number" || !entry.data || !entry.provenance) return null;
  const provenance = entry.provenance as Partial<LimitsProvenance>;
  if ((provenance.source !== "live" && provenance.source !== "transcript" && provenance.source !== "cache" && provenance.source !== "unavailable") ||
      (typeof provenance.reason !== "string" && provenance.reason !== null) ||
      (typeof provenance.staleSince !== "string" && provenance.staleSince !== null)) return null;
  return entry as EngineCacheEntry;
}

function readDiskCache(): LimitsCache {
  try {
    const raw = JSON.parse(fs.readFileSync(LIMITS_CACHE_FILE, "utf8")) as Partial<LimitsCache> & { at?: unknown; accountId?: unknown; data?: LimitsPayload };
    if (raw.version === 2 && raw.engines && typeof raw.engines === "object") {
      const cache = emptyCache();
      for (const engine of ["claude", "codex"] as const) {
        const entries = raw.engines[engine];
        if (!entries || typeof entries !== "object") continue;
        for (const [id, entry] of Object.entries(entries)) {
          const valid = safeCacheEntry(entry);
          if (valid) cache.engines[engine][id] = valid;
        }
      }
      return cache;
    }
    // Preserve the usable half of a pre-v2 cache during the one-time upgrade.
    if (typeof raw.at === "number" && typeof raw.accountId === "string" && raw.data?.codex) {
      const provenance = isProvenance(raw.data.provenance) ? raw.data.provenance.codex : { source: "cache" as const, reason: "legacy cache provenance unavailable", staleSince: raw.data.staleSince ?? null };
      return { version: 2, engines: { claude: {}, codex: { [raw.accountId]: { at: raw.at, data: raw.data.codex, provenance } } } };
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
    fs.mkdirSync(path.dirname(LIMITS_CACHE_FILE), { recursive: true });
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
    fs.writeFileSync(LIMITS_CACHE_FILE, JSON.stringify({ ...value, ...projection }, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[limits] failed to persist cache", err);
  }
}

function lastCache(engine: EngineName, accountId: string): EngineCacheEntry | null {
  return cache().engines[engine][accountId] ?? null;
}

function remember(engine: EngineName, accountId: string, resolved: { data: EngineLimits | null; meta: LimitsProvenance }): void {
  if (!resolved.data || resolved.meta.source === "cache" || resolved.meta.source === "unavailable") return;
  cache().engines[engine][accountId] = { at: Date.now(), data: resolved.data, provenance: resolved.meta };
  writeDiskCache(cache());
}

function safeReason(reason: string): string {
  return reason
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|id)[_-]?token\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function provenance(read: LimitRead, cached: EngineCacheEntry | null, staleSince: string): { data: EngineLimits | null; meta: LimitsProvenance } {
  if (read.data) return { data: read.data, meta: { source: read.source, reason: read.reason, staleSince: read.reason ? staleSince : null } };
  if (cached) return { data: cached.data, meta: { source: "cache", reason: read.reason, staleSince: cached.provenance.staleSince ?? staleSince } };
  return { data: null, meta: { source: "unavailable", reason: read.reason, staleSince } };
}

function logFallbackReasons(claude: LimitsProvenance, codex: LimitsProvenance): void {
  for (const [engine, meta] of Object.entries({ claude, codex })) {
    if (meta.reason) console.warn(`[limits] ${engine} fallback: ${safeReason(meta.reason)}`);
  }
}

/** Claude Code + Codex plan limits, cached briefly so UI polling stays cheap. */
export async function readLimits(): Promise<LimitsPayload> {
  const claudeAccount = claudeAccountForSpawn();
  const codexAccount = accountForSpawn();
  const cachedClaude = lastCache("claude", claudeAccount.id);
  const cachedCodex = lastCache("codex", codexAccount.id);
  const claudeFresh = Boolean(cachedClaude && Date.now() - cachedClaude.at < CACHE_MS);
  const codexFresh = Boolean(cachedCodex && Date.now() - cachedCodex.at < CACHE_MS);
  if (claudeFresh && codexFresh) {
    return { claude: cachedClaude?.data ?? null, codex: cachedCodex?.data ?? null, claudeAccountId: claudeAccount.id, codexAccountId: codexAccount.id, provenance: { claude: cachedClaude?.provenance ?? { source: "unavailable", reason: "no cached Claude limits", staleSince: null }, codex: cachedCodex?.provenance ?? { source: "unavailable", reason: "no cached Codex limits", staleSince: null } }, staleSince: cachedClaude?.provenance.staleSince ?? cachedCodex?.provenance.staleSince ?? null };
  }
  const staleSince = new Date().toISOString();
  const [claude, codex] = await Promise.all([
    claudeFresh ? Promise.resolve(null) : fetchClaudeLimits(path.join(claudeAccount.home, ".credentials.json")),
    codexFresh ? Promise.resolve(null) : readCodexLimits({ account: codexAccount }),
  ]);
  const resolvedClaude = claudeFresh
    ? { data: cachedClaude!.data, meta: cachedClaude!.provenance }
    : provenance(claude!, cachedClaude, staleSince);
  const resolvedCodex = codexFresh
    ? { data: cachedCodex!.data, meta: cachedCodex!.provenance }
    : provenance(codex!, cachedCodex, staleSince);
  const data: LimitsPayload = {
    claude: resolvedClaude.data,
    codex: resolvedCodex.data,
    claudeAccountId: claudeAccount.id,
    codexAccountId: codexAccount.id,
    provenance: { claude: resolvedClaude.meta, codex: resolvedCodex.meta },
    staleSince: resolvedClaude.meta.staleSince ?? resolvedCodex.meta.staleSince,
  };
  logFallbackReasons(data.provenance.claude, data.provenance.codex);
  if (!claudeFresh) remember("claude", claudeAccount.id, resolvedClaude);
  if (!codexFresh) remember("codex", codexAccount.id, resolvedCodex);
  return data;
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
export async function fetchClaudeLimits(credentialsPath: string): Promise<LimitRead> {
  let accessToken = "";
  let plan: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; subscriptionType?: unknown };
    };
    if (typeof raw.claudeAiOauth?.accessToken === "string") accessToken = raw.claudeAiOauth.accessToken;
    if (typeof raw.claudeAiOauth?.subscriptionType === "string") plan = raw.claudeAiOauth.subscriptionType;
  } catch (err) {
    return { data: null, reason: `credentials unreadable: ${err instanceof Error ? err.message : String(err)}`, source: "unavailable" };
  }
  if (!accessToken) return { data: null, reason: "credentials missing access token", source: "unavailable" };
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: {
        authorization: "Bearer " + accessToken,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { data: null, reason: `oauth usage status ${res.status}`, source: "unavailable" };
    const json = (await res.json()) as { five_hour?: OauthWindow; seven_day?: OauthWindow };
    const data = {
      session: oauthWindow(json.five_hour),
      weekly: oauthWindow(json.seven_day),
      plan,
      capturedAt: null,
    };
    if (!data.session && !data.weekly) return { data: null, reason: "oauth usage response had no windows", source: "unavailable" };
    return { data, reason: null, source: "live" };
  } catch (err) {
    return { data: null, reason: `oauth usage fetch failed: ${err instanceof Error ? err.message : String(err)}`, source: "unavailable" };
  }
}

function oauthWindow(w: OauthWindow | undefined): LimitWindow | null {
  if (!w || typeof w.utilization !== "number") return null;
  const resets = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
  return { usedPercent: w.utilization, resetsAt: Number.isFinite(resets) ? Math.round(resets / 1000) : null };
}

/* -------------------------------- Codex -------------------------------- */

interface CodexWindow {
  used_percent?: unknown;
  resets_at?: unknown;
  resets_in_seconds?: unknown;
}

interface CodexRateLimits {
  primary?: CodexWindow;
  secondary?: CodexWindow;
  plan_type?: unknown;
}

export function mapAppServerRateLimits(rateLimits: AppServerRateLimits, capturedAt = Math.round(Date.now() / 1000)): EngineLimits {
  return {
    session: rateLimits.primary ? { usedPercent: rateLimits.primary.usedPercent, resetsAt: rateLimits.primary.resetsAt } : null,
    weekly: rateLimits.secondary ? { usedPercent: rateLimits.secondary.usedPercent, resetsAt: rateLimits.secondary.resetsAt } : null,
    plan: rateLimits.planType,
    capturedAt,
  };
}

/**
 * Managed homes receive a fresh structured snapshot from the app-server. The
 * transcript scanner remains a compatibility fallback when that local host is
 * unavailable; its reason keeps old quota data visibly stale.
 */
export async function readCodexLimits(options: {
  account?: Pick<CodexAccount, "id" | "kind" | "home" | "sessionsDir">;
  liveReader?: CodexLiveLimitsReader;
} = {}): Promise<LimitRead> {
  const account = options.account ?? accountForSpawn();
  if (account.kind === "managed") {
    try {
      const rateLimits = await (options.liveReader ?? ((candidate) => managedCodexRuntime().readRateLimits(candidate as CodexAccount)))(account);
      return { data: mapAppServerRateLimits(rateLimits), reason: null, source: "live" };
    } catch (error) {
      const fallback = readCodexTranscriptLimits(account.sessionsDir);
      const detail = error instanceof Error ? error.message : String(error);
      if (fallback.data) return { data: fallback.data, reason: `app-server unavailable; transcript fallback: ${detail}`, source: "transcript" };
      return { data: null, reason: `app-server unavailable: ${detail}; ${fallback.reason}`, source: "unavailable" };
    }
  }
  return readCodexTranscriptLimits(account.sessionsDir);
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

/** Session transcripts for one Codex account home, newest first. */
function* latestSessionFiles(sessionsDir: string): Generator<string> {
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
          yield entry.p;
          if (++yielded >= MAX_FILES) return;
        }
      }
    }
  }
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
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const row = JSON.parse(line) as { timestamp?: unknown; payload?: { rate_limits?: CodexRateLimits } };
      const rl = row.payload?.rate_limits;
      if (!rl) continue;
      const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
      const capturedAt = Number.isFinite(ts) ? Math.round(ts / 1000) : null;
      return {
        session: codexWindow(rl.primary, capturedAt),
        weekly: codexWindow(rl.secondary, capturedAt),
        plan: typeof rl.plan_type === "string" ? rl.plan_type : null,
        capturedAt,
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
  return { usedPercent: w.used_percent, resetsAt };
}
