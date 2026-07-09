import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountForSpawn, type CodexAccount } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import type { AppServerRateLimits } from "@/lib/accounts/codexAppServer";
import { statePath } from "@/lib/configDir";
import type { EngineLimits, LimitsPayload, LimitsProvenance, LimitWindow } from "./types";

const HOME = os.homedir();
const CLAUDE_CREDENTIALS = path.join(HOME, ".claude", ".credentials.json");
const LIMITS_CACHE_FILE = statePath("limits-cache.json");
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** How far back into a session file to look for the last rate-limit event. */
const TAIL_BYTES = 192 * 1024;
/** Newest session files to try before giving up (fresh ones may lack limits). */
const MAX_FILES = 12;
const CACHE_MS = 30_000;

type LimitsCacheEntry = { at: number; accountId: string; data: LimitsPayload };
export type LimitRead = { data: EngineLimits | null; reason: string | null; source: "live" | "transcript" | "unavailable" };
export type CodexLiveLimitsReader = (account: Pick<CodexAccount, "id" | "kind" | "home" | "sessionsDir">) => Promise<AppServerRateLimits>;

const globalStore = globalThis as unknown as {
  __llvLimitsCache?: LimitsCacheEntry | null;
};

function hasLimits(data: LimitsPayload): boolean {
  return Boolean(data.claude || data.codex);
}

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

function cleanPayload(data: LimitsPayload, accountId = data.codexAccountId): LimitsPayload {
  const legacyStaleSince = data.staleSince ?? null;
  const provenance = isProvenance(data.provenance) ? data.provenance : {
    claude: { source: "cache" as const, reason: "legacy cache provenance unavailable", staleSince: legacyStaleSince },
    codex: { source: "cache" as const, reason: "legacy cache provenance unavailable", staleSince: legacyStaleSince },
  };
  return {
    claude: data.claude,
    codex: data.codex,
    codexAccountId: typeof data.codexAccountId === "string" ? data.codexAccountId : accountId,
    provenance,
    staleSince: legacyStaleSince,
  };
}

function readDiskCache(accountId: string): LimitsCacheEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LIMITS_CACHE_FILE, "utf8")) as Partial<LimitsCacheEntry>;
    if (!raw || typeof raw.at !== "number" || raw.accountId !== accountId || !raw.data) return null;
    const data = cleanPayload(raw.data, accountId);
    if (!hasLimits(data)) return null;
    return { at: raw.at, accountId, data };
  } catch {
    return null;
  }
}

function writeDiskCache(entry: LimitsCacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(LIMITS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(LIMITS_CACHE_FILE, JSON.stringify(entry, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[limits] failed to persist cache", err);
  }
}

function lastCache(accountId: string): LimitsCacheEntry | null {
  if (globalStore.__llvLimitsCache?.accountId === accountId) {
    const entry = globalStore.__llvLimitsCache;
    return { ...entry, data: cleanPayload(entry.data, accountId) };
  }
  globalStore.__llvLimitsCache = readDiskCache(accountId);
  return globalStore.__llvLimitsCache ?? null;
}

function remember(accountId: string, data: LimitsPayload): LimitsPayload {
  const entry = { at: Date.now(), accountId, data: cleanPayload(data) };
  globalStore.__llvLimitsCache = entry;
  writeDiskCache(entry);
  return entry.data;
}

function safeReason(reason: string): string {
  return reason
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|id)[_-]?token\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function provenance(read: LimitRead, cached: EngineLimits | null, staleSince: string): { data: EngineLimits | null; meta: LimitsProvenance } {
  if (read.data) return { data: read.data, meta: { source: read.source, reason: read.reason, staleSince: read.reason ? staleSince : null } };
  if (cached) return { data: cached, meta: { source: "cache", reason: read.reason, staleSince } };
  return { data: null, meta: { source: "unavailable", reason: read.reason, staleSince } };
}

function logFallbackReasons(claude: LimitsProvenance, codex: LimitsProvenance): void {
  for (const [engine, meta] of Object.entries({ claude, codex })) {
    if (meta.reason) console.warn(`[limits] ${engine} fallback: ${safeReason(meta.reason)}`);
  }
}

/** Claude Code + Codex plan limits, cached briefly so UI polling stays cheap. */
export async function readLimits(): Promise<LimitsPayload> {
  const accountId = accountForSpawn().id;
  const cached = lastCache(accountId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const staleSince = new Date().toISOString();
  const [claude, codex] = await Promise.all([fetchClaudeLimits(), readCodexLimits()]);
  const resolvedClaude = provenance(claude, cached?.data.claude ?? null, staleSince);
  const resolvedCodex = provenance(codex, cached?.data.codex ?? null, staleSince);
  const data: LimitsPayload = {
    claude: resolvedClaude.data,
    codex: resolvedCodex.data,
    codexAccountId: accountId,
    provenance: { claude: resolvedClaude.meta, codex: resolvedCodex.meta },
    staleSince: resolvedClaude.meta.staleSince ?? resolvedCodex.meta.staleSince,
  };
  logFallbackReasons(data.provenance.claude, data.provenance.codex);
  if (hasLimits(data)) {
    return remember(accountId, data);
  }
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
async function fetchClaudeLimits(): Promise<LimitRead> {
  let accessToken = "";
  let plan: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS, "utf8")) as {
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
