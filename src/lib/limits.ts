import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountForSpawn } from "@/lib/accounts/codex";
import { statePath } from "@/lib/configDir";
import type { EngineLimits, LimitsPayload, LimitWindow } from "./types";

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
type LimitRead = { data: EngineLimits | null; reason: string | null };

const globalStore = globalThis as unknown as {
  __llvLimitsCache?: LimitsCacheEntry | null;
};

function hasLimits(data: LimitsPayload): boolean {
  return Boolean(data.claude || data.codex);
}

function cleanPayload(data: LimitsPayload): LimitsPayload {
  return { claude: data.claude, codex: data.codex, staleSince: data.staleSince ?? null };
}

function readDiskCache(accountId: string): LimitsCacheEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LIMITS_CACHE_FILE, "utf8")) as Partial<LimitsCacheEntry>;
    if (!raw || typeof raw.at !== "number" || raw.accountId !== accountId || !raw.data) return null;
    const data = cleanPayload(raw.data);
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
  if (globalStore.__llvLimitsCache?.accountId === accountId) return globalStore.__llvLimitsCache;
  globalStore.__llvLimitsCache = readDiskCache(accountId);
  return globalStore.__llvLimitsCache ?? null;
}

function remember(accountId: string, data: LimitsPayload): LimitsPayload {
  const entry = { at: Date.now(), accountId, data: cleanPayload(data) };
  globalStore.__llvLimitsCache = entry;
  writeDiskCache({ ...entry, data: cleanPayload({ ...data, staleSince: null }) });
  return entry.data;
}

function fallbackFromCache(cache: LimitsCacheEntry | null, staleSince: string): LimitsPayload {
  if (!cache) return { claude: null, codex: null, staleSince };
  return { ...cache.data, staleSince };
}

function logRefreshMiss(claude: LimitRead, codex: LimitRead, cached: boolean): void {
  const reasons = [`claude=${claude.reason ?? "ok"}`, `codex=${codex.reason ?? "ok"}`].join(" ");
  console.warn(`[limits] refresh returned no fresh values; ${reasons}; cached=${cached ? "yes" : "no"}`);
}

function logPartialFallback(claude: LimitRead, codex: LimitRead): void {
  const reasons = [`claude=${claude.reason ?? "ok"}`, `codex=${codex.reason ?? "ok"}`].join(" ");
  console.warn(`[limits] refresh used cached value for one engine; ${reasons}`);
}

/** Claude Code + Codex plan limits, cached briefly so UI polling stays cheap. */
export async function readLimits(): Promise<LimitsPayload> {
  const accountId = accountForSpawn().id;
  const cached = lastCache(accountId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const staleSince = new Date().toISOString();
  const [claude, codex] = await Promise.all([fetchClaudeLimits(), Promise.resolve(readCodexLimits())]);
  const data: LimitsPayload = {
    claude: claude.data ?? cached?.data.claude ?? null,
    codex: codex.data ?? cached?.data.codex ?? null,
    staleSince: claude.data && codex.data ? null : staleSince,
  };
  if (hasLimits(data)) {
    if (!claude.data || !codex.data) logPartialFallback(claude, codex);
    return remember(accountId, data);
  }
  logRefreshMiss(claude, codex, Boolean(cached));
  return fallbackFromCache(cached, staleSince);
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
    return { data: null, reason: `credentials unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!accessToken) return { data: null, reason: "credentials missing access token" };
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: {
        authorization: "Bearer " + accessToken,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { data: null, reason: `oauth usage status ${res.status}` };
    const json = (await res.json()) as { five_hour?: OauthWindow; seven_day?: OauthWindow };
    const data = {
      session: oauthWindow(json.five_hour),
      weekly: oauthWindow(json.seven_day),
      plan,
      capturedAt: null,
    };
    if (!data.session && !data.weekly) return { data: null, reason: "oauth usage response had no windows" };
    return { data, reason: null };
  } catch (err) {
    return { data: null, reason: `oauth usage fetch failed: ${err instanceof Error ? err.message : String(err)}` };
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

/**
 * Codex has no local credentials-only usage endpoint, but every turn the CLI
 * appends a token_count event with the server-reported rate_limits to its
 * session transcript. The last such event in the newest transcript is the
 * freshest number available offline.
 */
export function readCodexLimits(): LimitRead {
  let scanned = 0;
  for (const file of latestSessionFiles()) {
    scanned += 1;
    const hit = lastRateLimits(file);
    if (hit) return { data: hit, reason: null };
  }
  return { data: null, reason: scanned === 0 ? "no codex session files" : `no rate_limits event in newest ${scanned} session files` };
}

function listDesc(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

/** Session transcripts for the account a new Codex pane will use, newest first. */
function* latestSessionFiles(): Generator<string> {
  const sessionsDir = accountForSpawn().sessionsDir;
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
