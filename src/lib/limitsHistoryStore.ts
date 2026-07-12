import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { clampPercent, type WindowKey } from "@/lib/burndown";
import type { EngineLimits, LimitSample } from "@/lib/types";

/** Forward poll history for the burndown chart. Claude quota is a live-only
    snapshot with no transcript record, so its curve can only be built by
    persisting each poll here; the Codex curve is additionally backfilled from
    transcripts (see limits.ts). The prod viewer polls every 60s continuously,
    so this doubles as the sampler — no separate daemon. */

/** Keep just over a week so the weekly window is always fully covered. */
export const RETENTION_S = 8 * 24 * 3600;
/** One sample per engine/window per 5 minutes is plenty for the chart. */
const MIN_GAP_S = 5 * 60;
/** Hard cap per series so a stuck poller can never grow the file unbounded. */
const MAX_POINTS = 4000;

type EngineName = "claude" | "codex";
const WINDOWS: WindowKey[] = ["session", "weekly"];

interface HistoryFile {
  version: 1;
  /** ISO of the first sample ever recorded — the "history builds from" hint. */
  since: string | null;
  /** `${engine}|${accountId}|${window}` → samples, oldest first. */
  series: Record<string, LimitSample[]>;
}

function historyFile(): string {
  return statePath("limits-history.json");
}

function seriesKey(engine: EngineName, accountId: string, window: WindowKey): string {
  return `${engine}|${accountId}|${window}`;
}

function emptyHistory(): HistoryFile {
  return { version: 1, since: null, series: {} };
}

function isSample(value: unknown): value is LimitSample {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<LimitSample>;
  return typeof s.t === "number" && Number.isFinite(s.t) && typeof s.remaining === "number" && Number.isFinite(s.remaining);
}

export function readHistory(): HistoryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), "utf8")) as Partial<HistoryFile>;
    if (raw.version !== 1 || !raw.series || typeof raw.series !== "object") return emptyHistory();
    const series: Record<string, LimitSample[]> = {};
    for (const [key, value] of Object.entries(raw.series)) {
      if (Array.isArray(value)) series[key] = value.filter(isSample);
    }
    return { version: 1, since: typeof raw.since === "string" ? raw.since : null, series };
  } catch {
    // A missing or unreadable history file is simply an empty series.
    return emptyHistory();
  }
}

function writeHistory(history: HistoryFile): void {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify(history, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[limits] failed to persist history", err);
  }
}

/** Read one engine/account/window series, pruned to the retention window. */
export function historySamples(engine: EngineName, accountId: string, window: WindowKey, now = Math.round(Date.now() / 1000)): LimitSample[] {
  const arr = readHistory().series[seriesKey(engine, accountId, window)] ?? [];
  const cutoff = now - RETENTION_S;
  return arr.filter((s) => s.t >= cutoff);
}

/** Append the current live remaining-quota values for an engine/account, one
    point per window. Downsampled to {@link MIN_GAP_S}, pruned to the retention
    window and capped, so the file stays small across a long-running viewer. */
export function recordLimitSample(engine: EngineName, accountId: string, limits: EngineLimits, nowMs = Date.now()): void {
  const nowS = Math.round(nowMs / 1000);
  const history = readHistory();
  let changed = false;
  for (const window of WINDOWS) {
    const win = limits[window];
    if (!win || typeof win.usedPercent !== "number") continue;
    const key = seriesKey(engine, accountId, window);
    const arr = history.series[key] ?? (history.series[key] = []);
    const last = arr[arr.length - 1];
    if (last && nowS - last.t < MIN_GAP_S) continue;
    arr.push({ t: nowS, remaining: clampPercent(100 - win.usedPercent) });
    const cutoff = nowS - RETENTION_S;
    let pruned = arr.filter((s) => s.t >= cutoff);
    if (pruned.length > MAX_POINTS) pruned = pruned.slice(pruned.length - MAX_POINTS);
    history.series[key] = pruned;
    changed = true;
  }
  if (!changed) return;
  if (!history.since) history.since = new Date(nowMs).toISOString();
  writeHistory(history);
}

/** ISO time the forward history began (for the sparse-state hint), or null. */
export function historySince(): string | null {
  return readHistory().since;
}
