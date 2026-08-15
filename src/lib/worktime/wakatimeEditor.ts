import crypto from "node:crypto";

import { canonicalProject } from "@/lib/projects/aliases";

import { kyivDayBounds } from "./calculator";
import type { EditorInterval } from "./types";

const HEARTBEAT_TIMEOUT_MS = 15 * 60_000;
const BOUNDARY_PROJECT = "agent-log-viewer-boundary";
const RAW_HEARTBEATS_ENDPOINT = "https://api.wakatime.com/api/v1/users/current/heartbeats";

export interface WakatimeEditorHeartbeat {
  entity: string;
  type: string;
  category: string;
  project: string | null;
  time: number;
}

interface WakatimeRawResponse {
  status: number;
  json(): Promise<unknown>;
}

function digest(...parts: Array<string | number>): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function synthetic(heartbeat: WakatimeEditorHeartbeat): boolean {
  return heartbeat.entity.startsWith("agent-log-viewer/") || heartbeat.project === BOUNDARY_PROJECT;
}

function intervalsFor(
  day: string,
  heartbeats: Array<WakatimeEditorHeartbeat & { atMs: number }>,
  includeProject: boolean,
): EditorInterval[] {
  const groups = new Map<string, Array<WakatimeEditorHeartbeat & { atMs: number }>>();
  for (const heartbeat of heartbeats) {
    const key = includeProject
      ? heartbeat.project ?? ""
      : `${heartbeat.project ?? ""}\0${heartbeat.entity}`;
    const group = groups.get(key) ?? [];
    group.push(heartbeat);
    groups.set(key, group);
  }
  const intervals: EditorInterval[] = [];
  for (const [key, group] of groups) {
    const times = [...new Set(group.map((heartbeat) => heartbeat.atMs))].sort((left, right) => left - right);
    for (let index = 0; index < times.length - 1; index += 1) {
      const startMs = times[index]!;
      const endMs = times[index + 1]!;
      if (endMs <= startMs || endMs - startMs > HEARTBEAT_TIMEOUT_MS) continue;
      intervals.push({
        project: includeProject && key ? key : null,
        startMs,
        endMs,
        evidenceDigest: digest("llv-worktime-wakatime-v1", day, key, startMs, endMs),
      });
    }
  }
  return intervals.sort((left, right) => left.startMs - right.startMs || (left.project ?? "").localeCompare(right.project ?? ""));
}

function unionDuration(intervals: EditorInterval[]): number {
  const ordered = intervals.slice().sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of ordered) {
    if (start === null || end === null || interval.startMs > end) {
      if (start !== null && end !== null) total += end - start;
      start = interval.startMs;
      end = interval.endMs;
    } else {
      end = Math.max(end, interval.endMs);
    }
  }
  if (start !== null && end !== null) total += end - start;
  return total;
}

export function editorEvidenceFromHeartbeats(
  day: string,
  heartbeats: WakatimeEditorHeartbeat[],
): { intervals: EditorInterval[]; excludedSyntheticMs: number } {
  const bounds = kyivDayBounds(day);
  const valid = heartbeats
    .filter((heartbeat) => typeof heartbeat.entity === "string"
      && Number.isFinite(heartbeat.time)
      && (heartbeat.project === null || typeof heartbeat.project === "string"))
    .map((heartbeat) => ({ ...heartbeat, atMs: Math.round(heartbeat.time * 1_000) }))
    .filter((heartbeat) => heartbeat.atMs >= bounds.startMs && heartbeat.atMs < bounds.endMs);
  const viewer = valid.filter(synthetic);
  const editor = valid
    .filter((heartbeat) => !synthetic(heartbeat))
    .map((heartbeat) => ({
      ...heartbeat,
      project: heartbeat.project ? canonicalProject(heartbeat.project) : null,
    }));
  return {
    intervals: intervalsFor(day, editor, true),
    excludedSyntheticMs: unionDuration(intervalsFor(day, viewer, false)),
  };
}

function adjacentDay(day: string, offset: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, date! + offset));
  return shifted.toISOString().slice(0, 10);
}

function heartbeatFrom(value: unknown): WakatimeEditorHeartbeat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<WakatimeEditorHeartbeat>;
  if (typeof candidate.entity !== "string"
    || typeof candidate.type !== "string"
    || typeof candidate.category !== "string"
    || !(candidate.project === null || typeof candidate.project === "string")
    || typeof candidate.time !== "number" || !Number.isFinite(candidate.time)) return null;
  return candidate as WakatimeEditorHeartbeat;
}

/**
 * Reads raw heartbeats for the UTC-date envelope around a Kyiv day. The
 * account's configured timezone may differ, so the local day is enforced only
 * after all three adjacent date responses have been collected.
 */
export async function fetchWakatimeEditorEvidence(
  day: string,
  credential: string,
  request: (url: string, init: RequestInit) => Promise<WakatimeRawResponse> = (url, init) => fetch(url, init),
): Promise<{ intervals: EditorInterval[]; excludedSyntheticMs: number }> {
  kyivDayBounds(day);
  const key = credential.trim();
  if (!key) throw new Error("WakaTime credential is unavailable");
  const dates = [adjacentDay(day, -1), day, adjacentDay(day, 1)];
  const responses = await Promise.all(dates.map(async (date) => {
    const url = new URL(RAW_HEARTBEATS_ENDPOINT);
    url.searchParams.set("date", date);
    const response = await request(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(key).toString("base64")}`,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`WakaTime heartbeat request failed with status ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error("invalid WakaTime heartbeat response");
    }
    const values = (payload as { data: unknown[] }).data;
    const heartbeats = values.map(heartbeatFrom);
    if (heartbeats.some((heartbeat) => heartbeat === null)) {
      throw new Error("invalid WakaTime heartbeat response");
    }
    return heartbeats as WakatimeEditorHeartbeat[];
  }));
  const unique = new Map<string, WakatimeEditorHeartbeat>();
  for (const heartbeat of responses.flat()) {
    unique.set(digest(
      heartbeat.entity,
      heartbeat.type,
      heartbeat.category,
      heartbeat.project ?? "",
      heartbeat.time,
    ), heartbeat);
  }
  return editorEvidenceFromHeartbeats(day, [...unique.values()]);
}
