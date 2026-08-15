import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentRegistry, conversationLookupFromSnapshot, type RegistryFile } from "@/lib/agent/registry";
import { configFilePath, statePath } from "@/lib/configDir";
import {
  currentFileScan,
  persistedFileScanSnapshot,
  type FileScanSnapshot,
} from "@/lib/scanner/scanCache";
import { recentTurnWindowsFor, type RecentTurnWindows } from "@/lib/scanner/turnDuration";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import type { FileEntry, TurnBoundary } from "@/lib/types";

import { acquireWakatimeSchedulerLease, type WakatimeSchedulerLease } from "./lease";
import {
  acknowledgeDirectOperatorWakatimeActions,
  readDirectOperatorWakatimeActions,
  type DirectOperatorWakatimeAction,
} from "./operatorActivity";

const ENDPOINT = "https://api.wakatime.com/api/v1/users/current/heartbeats.bulk";
const SAMPLE_INTERVAL_MS = 120_000;
const TICK_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BATCH = 25;
const OPERATOR_ENGAGEMENT_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 10_000;
const DEFAULT_MAX_STREAMS = 5_000;
const CLOSED_STREAM_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_COMPACT_GAP_MS = 10 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
const AUTH_RETRY_MS = 15 * 60_000;
const DIAGNOSTIC_REPEAT_MS = 60 * 60_000;
const BOUNDARY_PROJECT = "agent-log-viewer-boundary";

export interface WakatimeHeartbeat {
  entity: string;
  type: "app";
  project: string;
  category: "ai coding";
  time: number;
  ai_session: string;
}

export interface WakatimeStateV1 {
  version: 1;
  enabledAtMs: number;
  credentialGeneration: string | null;
  streams: Record<string, {
    entity: string;
    engine: "claude" | "codex";
    project: string;
    startedAtMs: number;
    endedAtMs: number | null;
    lastMaterializedAtMs: number;
    lastObservedAtMs: number;
    boundaryFinalizedAtMs?: number | null;
  }>;
  retiredStreams?: Record<string, {
    lastMaterializedAtMs: number;
    lastObservedAtMs: number;
    boundaryFinalizedAtMs: number | null;
    expiresAtMs: number;
  }>;
  pending: Array<{
    key: string;
    stream: string;
    kind: "activity" | "boundary";
    createdAtMs: number;
    heartbeat: WakatimeHeartbeat;
  }>;
  retry: {
    failures: number;
    retryAtMs: number;
    reason: "network" | "timeout" | "rate_limit" | "server" | "auth" | null;
  };
  counters: {
    accepted: number;
    permanentlyRejected: number;
    compacted: number;
    dropped: number;
    historyGaps: number;
  };
}

export interface WakatimeCredential {
  value: string;
  sourceStamp: string;
}

interface TimerHandle {
  unref?(): unknown;
}

interface WakatimeResponse {
  status: number;
  headers: Pick<Headers, "get">;
  text(): Promise<string>;
}

export interface WakatimeSyncDependencies {
  scan(): Promise<{ files: FileEntry[]; complete: boolean }>;
  registrySnapshot(): RegistryFile;
  recentTurnWindows(entry: FileEntry): RecentTurnWindows;
  readOperatorActions?(): Promise<DirectOperatorWakatimeAction[]> | DirectOperatorWakatimeAction[];
  acknowledgeOperatorActions?(keys: readonly string[]): Promise<void> | void;
  readCredential(): Promise<WakatimeCredential | null> | WakatimeCredential | null;
  readState(): Promise<unknown | null> | unknown | null;
  writeState(state: WakatimeStateV1): Promise<void> | void;
  fetch(url: string, init: RequestInit): Promise<WakatimeResponse>;
  now(): number;
  random(): number;
  scheduleInterval(callback: () => void, delayMs: number): TimerHandle;
  scheduleTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  acquireSchedulerLease(): WakatimeSchedulerLease | null;
  logger(event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
  limits?: { maxPending?: number; maxStreams?: number };
}

export interface WakatimeSync {
  tick(): Promise<void>;
  stop(): void;
}

function digest(...parts: Array<string | number>): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function turnDigest(conversationId: string, startedAtMs: number): string {
  return digest("llv-wakatime-v1", conversationId, startedAtMs);
}

function eventKey(stream: string, sampleTimeMs: number, kind: "activity" | "boundary" = "activity"): string {
  return digest(kind === "activity" ? "llv-wakatime-heartbeat-v1" : "llv-wakatime-boundary-v1", stream, sampleTimeMs);
}

function freshState(now: number): WakatimeStateV1 {
  return {
    version: 1,
    enabledAtMs: now,
    credentialGeneration: null,
    streams: {},
    retiredStreams: {},
    pending: [],
    retry: { failures: 0, retryAtMs: 0, reason: null },
    counters: { accepted: 0, permanentlyRejected: 0, compacted: 0, dropped: 0, historyGaps: 0 },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function heartbeatFrom(value: unknown): WakatimeHeartbeat | null {
  if (!record(value)
    || typeof value.entity !== "string" || value.entity.length === 0
    || value.type !== "app"
    || typeof value.project !== "string" || value.project.length === 0
    || value.category !== "ai coding"
    || !finite(value.time)
    || typeof value.ai_session !== "string" || value.ai_session.length !== 64) return null;
  return {
    entity: value.entity,
    type: "app",
    project: value.project,
    category: "ai coding",
    time: value.time,
    ai_session: value.ai_session,
  };
}

function stateFrom(value: unknown): WakatimeStateV1 | null {
  if (!record(value) || value.version !== 1 || !finite(value.enabledAtMs)
    || !record(value.streams) || !Array.isArray(value.pending)
    || !record(value.retry) || !record(value.counters)) return null;
  const credentialGeneration = value.credentialGeneration ?? null;
  if (!(credentialGeneration === null
    || (typeof credentialGeneration === "string" && /^[a-f0-9]{64}$/.test(credentialGeneration)))) return null;
  const streams: WakatimeStateV1["streams"] = {};
  for (const [key, candidate] of Object.entries(value.streams)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !record(candidate)
      || typeof candidate.entity !== "string"
      || (candidate.engine !== "claude" && candidate.engine !== "codex")
      || typeof candidate.project !== "string" || candidate.project.length === 0
      || !finite(candidate.startedAtMs)
      || !(candidate.endedAtMs === null || finite(candidate.endedAtMs))
      || !finite(candidate.lastMaterializedAtMs)
      || !finite(candidate.lastObservedAtMs)
      || !(candidate.boundaryFinalizedAtMs === undefined
        || candidate.boundaryFinalizedAtMs === null
        || finite(candidate.boundaryFinalizedAtMs))
      || (candidate.endedAtMs !== null && candidate.endedAtMs <= candidate.startedAtMs)
      || candidate.lastMaterializedAtMs < candidate.startedAtMs - 1) return null;
    streams[key] = {
      entity: candidate.entity,
      engine: candidate.engine,
      project: candidate.project,
      startedAtMs: candidate.startedAtMs,
      endedAtMs: candidate.endedAtMs,
      lastMaterializedAtMs: candidate.lastMaterializedAtMs,
      lastObservedAtMs: candidate.lastObservedAtMs,
      boundaryFinalizedAtMs: candidate.boundaryFinalizedAtMs ?? null,
    };
  }
  const retiredStreams: NonNullable<WakatimeStateV1["retiredStreams"]> = {};
  const rawRetiredStreams = value.retiredStreams ?? {};
  if (!record(rawRetiredStreams)) return null;
  for (const [key, candidate] of Object.entries(rawRetiredStreams)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !record(candidate)
      || !finite(candidate.lastMaterializedAtMs)
      || !finite(candidate.lastObservedAtMs)
      || !(candidate.boundaryFinalizedAtMs === null || finite(candidate.boundaryFinalizedAtMs))
      || !finite(candidate.expiresAtMs)) return null;
    retiredStreams[key] = {
      lastMaterializedAtMs: candidate.lastMaterializedAtMs,
      lastObservedAtMs: candidate.lastObservedAtMs,
      boundaryFinalizedAtMs: candidate.boundaryFinalizedAtMs,
      expiresAtMs: candidate.expiresAtMs,
    };
  }
  const pending: WakatimeStateV1["pending"] = [];
  const pendingKeys = new Set<string>();
  for (const candidate of value.pending) {
    if (!record(candidate) || typeof candidate.key !== "string" || !/^[a-f0-9]{64}$/.test(candidate.key)
      || typeof candidate.stream !== "string"
      || !finite(candidate.createdAtMs)) return null;
    const heartbeat = heartbeatFrom(candidate.heartbeat);
    if (!heartbeat) return null;
    const kind = candidate.kind === undefined ? "activity" : candidate.kind;
    if (kind !== "activity" && kind !== "boundary") return null;
    const stream = streams[candidate.stream];
    const sampleTimeMs = heartbeat.time * 1_000;
    if (!stream || !Number.isSafeInteger(sampleTimeMs)
      || heartbeat.ai_session !== candidate.stream
      || heartbeat.entity !== (kind === "boundary" ? `agent-log-viewer/boundary/${candidate.stream.slice(0, 16)}` : stream.entity)
      || heartbeat.project !== (kind === "boundary" ? BOUNDARY_PROJECT : stream.project)
      || candidate.key !== eventKey(candidate.stream, sampleTimeMs, kind)) return null;
    if (pendingKeys.has(candidate.key)) continue;
    pending.push({ key: candidate.key, stream: candidate.stream, kind, createdAtMs: candidate.createdAtMs, heartbeat });
    pendingKeys.add(candidate.key);
  }
  const retry = value.retry;
  const reason = retry.reason;
  if (!nonNegativeInteger(retry.failures) || !finite(retry.retryAtMs)
    || !(reason === null || reason === "network" || reason === "timeout" || reason === "rate_limit" || reason === "server" || reason === "auth")) return null;
  const counters = value.counters;
  if (!nonNegativeInteger(counters.accepted) || !nonNegativeInteger(counters.permanentlyRejected)
    || !nonNegativeInteger(counters.compacted) || !nonNegativeInteger(counters.dropped)
    || !nonNegativeInteger(counters.historyGaps)) return null;
  return {
    version: 1,
    enabledAtMs: value.enabledAtMs,
    credentialGeneration,
    streams,
    pending,
    retry: { failures: retry.failures, retryAtMs: retry.retryAtMs, reason },
    counters: {
      accepted: counters.accepted,
      permanentlyRejected: counters.permanentlyRejected,
      compacted: counters.compacted,
      dropped: counters.dropped,
      historyGaps: counters.historyGaps,
    },
    retiredStreams,
  };
}

function validWindow(window: TurnBoundary): boolean {
  return finite(window.startedAt) && window.startedAt > 0
    && (window.endedAt === null || (finite(window.endedAt) && window.endedAt > window.startedAt));
}

function sampleTimes(start: number, end: number, closed: boolean, last: number | null): number[] {
  const times: number[] = [];
  if (last === null) times.push(start);
  let sample = start + SAMPLE_INTERVAL_MS;
  if (last !== null) sample += Math.max(0, Math.floor((last - start) / SAMPLE_INTERVAL_MS)) * SAMPLE_INTERVAL_MS;
  while (sample <= end) {
    if (last === null || sample > last) times.push(sample);
    sample += SAMPLE_INTERVAL_MS;
  }
  if (closed && end > start && (last === null || end >= last) && times.at(-1) !== end) times.push(end);
  return times;
}

function addWindow(
  state: WakatimeStateV1,
  source: { engine: "claude" | "codex"; lastActivityAtMs: number },
  streamKey: string,
  project: string,
  window: TurnBoundary,
  now: number,
  existingKeys: Set<string>,
  openWindowActive: boolean,
  emitEndBoundary: boolean,
  respectEnabledAt: boolean = true,
): void {
  if (!validWindow(window)) return;
  if (respectEnabledAt && window.endedAt !== null && window.endedAt <= state.enabledAtMs) return;
  if (window.endedAt !== null && window.endedAt < now - CLOSED_STREAM_RETENTION_MS) return;
  const start = respectEnabledAt ? Math.max(window.startedAt, state.enabledAtMs) : window.startedAt;
  const existing = state.streams[streamKey];
  const retired = state.retiredStreams?.[streamKey];
  if (respectEnabledAt
    && window.endedAt === null && !openWindowActive && !existing && !retired
    && source.lastActivityAtMs <= state.enabledAtMs) return;
  const lastProvenActivityAt = Math.min(now, Math.max(
    start,
    source.lastActivityAtMs,
    existing?.lastObservedAtMs ?? retired?.lastObservedAtMs ?? start,
  ));
  const end = window.endedAt ?? (openWindowActive ? now : lastProvenActivityAt);
  if (end < start) return;
  if (!existing && retired
    && end <= retired.lastMaterializedAtMs
    && retired.boundaryFinalizedAtMs === end) return;
  const stream = existing ?? {
    entity: `agent-log-viewer/${source.engine}/${streamKey.slice(0, 16)}`,
    engine: source.engine,
    project,
    startedAtMs: window.startedAt,
    endedAtMs: window.endedAt,
    lastMaterializedAtMs: Math.max(start - 1, retired?.lastMaterializedAtMs ?? start - 1),
    lastObservedAtMs: retired?.lastObservedAtMs ?? now,
    boundaryFinalizedAtMs: retired?.boundaryFinalizedAtMs ?? null,
  };
  if (retired) delete state.retiredStreams?.[streamKey];
  stream.endedAtMs = window.endedAt;
  stream.lastObservedAtMs = window.endedAt ?? (openWindowActive ? now : lastProvenActivityAt);
  state.streams[streamKey] = stream;
  const last = stream.lastMaterializedAtMs < start ? null : stream.lastMaterializedAtMs;
  const closesObservedInterval = window.endedAt !== null || !openWindowActive;
  const boundaryAlreadyFinalized = stream.boundaryFinalizedAtMs === end;
  for (const sampleTimeMs of sampleTimes(start, end, closesObservedInterval && !boundaryAlreadyFinalized, last)) {
    const kind = closesObservedInterval && sampleTimeMs === end && emitEndBoundary ? "boundary" : "activity";
    const key = eventKey(streamKey, sampleTimeMs, kind);
    if (existingKeys.has(key)) continue;
    state.pending.push({
      key,
      stream: streamKey,
      kind,
      createdAtMs: now,
      heartbeat: {
        entity: kind === "boundary" ? `agent-log-viewer/boundary/${streamKey.slice(0, 16)}` : stream.entity,
        type: "app",
        project: kind === "boundary" ? BOUNDARY_PROJECT : stream.project,
        category: "ai coding",
        time: sampleTimeMs / 1_000,
        ai_session: streamKey,
      },
    });
    existingKeys.add(key);
  }
  stream.lastMaterializedAtMs = Math.max(stream.lastMaterializedAtMs, end);
  if (closesObservedInterval) stream.boundaryFinalizedAtMs = end;
}

function openTurnIsActive(entry: FileEntry): boolean {
  return entry.proc === "running"
    && entry.pid !== null
    && entry.activityReason !== "pane_at_composer"
    && entry.authoritativeTurn?.state !== "terminal"
    && entry.authoritativeTurn?.state !== "idle"
    && entry.pendingQuestion === null
    && entry.waitingInput === null;
}

function compactPending(state: WakatimeStateV1): number {
  const byStream = new Map<string, WakatimeStateV1["pending"]>();
  for (const event of state.pending) {
    const events = byStream.get(event.stream) ?? [];
    events.push(event);
    byStream.set(event.stream, events);
  }
  const retained: WakatimeStateV1["pending"] = [];
  for (const events of byStream.values()) {
    events.sort((a, b) => a.heartbeat.time - b.heartbeat.time);
    if (events.length <= 3) {
      retained.push(...events);
      continue;
    }
    const keep = new Set([events[0]!, events.at(-1)!]);
    const stream = state.streams[events[0]!.stream];
    if (stream?.endedAtMs !== null) {
      const final = events.find((event) => event.heartbeat.time * 1_000 === stream.endedAtMs);
      if (final) keep.add(final);
    }
    let latestInterior = events[0]!.heartbeat.time * 1_000;
    for (const event of events.slice(1, -1)) {
      const at = event.heartbeat.time * 1_000;
      if (at - latestInterior >= MAX_COMPACT_GAP_MS) {
        keep.add(event);
        latestInterior = at;
      }
    }
    retained.push(...events.filter((event) => keep.has(event)));
  }
  retained.sort((a, b) => a.createdAtMs - b.createdAtMs || a.heartbeat.time - b.heartbeat.time);
  const removed = state.pending.length - retained.length;
  state.pending = retained;
  return removed;
}

function enforceBounds(state: WakatimeStateV1, now: number, maxPending: number, maxStreams: number): void {
  state.retiredStreams ??= {};
  for (const [key, retired] of Object.entries(state.retiredStreams)) {
    if (retired.expiresAtMs < now) delete state.retiredStreams[key];
  }
  const pendingStreams = new Set(state.pending.map((event) => event.stream));
  for (const [key, stream] of Object.entries(state.streams)) {
    if (stream.endedAtMs !== null && stream.endedAtMs < now - CLOSED_STREAM_RETENTION_MS && !pendingStreams.has(key)) {
      delete state.streams[key];
    }
  }
  if (state.pending.length > maxPending) {
    const removed = compactPending(state);
    state.counters.compacted += removed;
  }
  while (state.pending.length > maxPending) {
    const oldest = [...new Set(state.pending.map((event) => event.stream))]
      .sort((a, b) => (state.streams[a]?.lastObservedAtMs ?? 0) - (state.streams[b]?.lastObservedAtMs ?? 0))[0];
    if (!oldest) break;
    const before = state.pending.length;
    state.pending = state.pending.filter((event) => event.stream !== oldest);
    delete state.streams[oldest];
    state.counters.dropped += before - state.pending.length;
  }
  const orderedStreams = Object.entries(state.streams).sort((a, b) => {
    const pendingDifference = Number(pendingStreams.has(a[0])) - Number(pendingStreams.has(b[0]));
    return pendingDifference || a[1].lastObservedAtMs - b[1].lastObservedAtMs;
  });
  while (orderedStreams.length > maxStreams) {
    const [key] = orderedStreams.shift()!;
    const stream = state.streams[key]!;
    const before = state.pending.length;
    state.pending = state.pending.filter((event) => event.stream !== key);
    state.counters.dropped += before - state.pending.length;
    if (before === state.pending.length) {
      state.retiredStreams[key] = {
        lastMaterializedAtMs: stream.lastMaterializedAtMs,
        lastObservedAtMs: stream.lastObservedAtMs,
        boundaryFinalizedAtMs: stream.boundaryFinalizedAtMs ?? null,
        expiresAtMs: Math.max(now, stream.endedAtMs ?? stream.lastObservedAtMs) + CLOSED_STREAM_RETENTION_MS,
      };
    }
    delete state.streams[key];
  }
}

function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, RETRY_AFTER_MAX_MS);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), RETRY_AFTER_MAX_MS) : 0;
}

function retryDelayMs(failures: number, random: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
  const jitter = 0.8 + Math.min(1, Math.max(0, random)) * 0.4;
  return Math.min(RETRY_MAX_MS, Math.round(base * jitter));
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function credentialGeneration(sourceStamp: string): string {
  return digest("llv-wakatime-credential-generation-v1", sourceStamp);
}

function bulkResponseStatuses(body: string, expected: number): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!record(parsed) || !Array.isArray(parsed.responses) || parsed.responses.length !== expected) return null;
  const statuses: number[] = [];
  for (const item of parsed.responses) {
    if (!Array.isArray(item) || item.length !== 2 || !record(item[0]) || !Number.isInteger(item[1])) return null;
    const status = item[1] as number;
    if (status < 100 || status > 599) return null;
    if (status >= 200 && status < 300) {
      if (!record(item[0].data) || typeof item[0].data.id !== "string" || item[0].data.id.length === 0) return null;
    } else if (!(typeof item[0].error === "string" || record(item[0].errors))) return null;
    statuses.push(status);
  }
  return statuses;
}

function retryReasonForItem(status: number): Exclude<WakatimeStateV1["retry"]["reason"], null> | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 302 || status === 429) return "rate_limit";
  if (status === 408 || status === 409 || status === 425 || status >= 500 || status < 200 || (status >= 300 && status < 400)) return "server";
  return null;
}

export function createWakatimeSync(deps: WakatimeSyncDependencies): WakatimeSync {
  let state: WakatimeStateV1 | null = null;
  let running: Promise<void> | null = null;
  let trailing = false;
  let stopped = false;
  let abortController: AbortController | null = null;
  let schedulerLease: WakatimeSchedulerLease | null = null;
  let missingCredential = false;
  const historyGapPaths = new Set<string>();
  const diagnostic = new Map<string, number>();
  const maxPending = Math.max(1, deps.limits?.maxPending ?? DEFAULT_MAX_PENDING);
  const maxStreams = Math.max(1, deps.limits?.maxStreams ?? DEFAULT_MAX_STREAMS);

  const report = (event: string, fields: Readonly<Record<string, string | number | boolean | null>> = {}, force = false) => {
    const now = deps.now();
    if (!force && now - (diagnostic.get(event) ?? Number.NEGATIVE_INFINITY) < DIAGNOSTIC_REPEAT_MS) return;
    diagnostic.set(event, now);
    deps.logger(event, fields);
  };

  const load = async (): Promise<WakatimeStateV1> => {
    if (state) return state;
    try {
      const raw = await deps.readState();
      if (raw === null) state = freshState(deps.now());
      else {
        state = stateFrom(raw);
        if (!state) {
          state = freshState(deps.now());
          report("corrupt_state_recovered");
        }
      }
    } catch {
      state = freshState(deps.now());
      report("corrupt_state_recovered");
    }
    return state;
  };

  const persist = async (current: WakatimeStateV1): Promise<boolean> => {
    try {
      await deps.writeState(structuredClone(current));
      return true;
    } catch {
      report("state_write_failed");
      return false;
    }
  };

  const observe = async (current: WakatimeStateV1): Promise<string[]> => {
    const now = deps.now();
    const existingKeys = new Set(current.pending.map((event) => event.key));
    const observations: Array<{
      source: { engine: "claude" | "codex"; lastActivityAtMs: number };
      streamKey: string;
      project: string;
      window: TurnBoundary;
      openWindowActive: boolean;
      respectEnabledAt: boolean;
    }> = [];
    let operatorActions: DirectOperatorWakatimeAction[] = [];
    try {
      operatorActions = await deps.readOperatorActions?.() ?? [];
    } catch {
      report("operator_activity_read_failed");
    }
    const acknowledgeable: string[] = [];
    for (const action of operatorActions) {
      const existing = current.streams[action.key];
      if ((existing && existing.startedAtMs !== action.atMs) || current.retiredStreams?.[action.key]) {
        acknowledgeable.push(action.key);
        continue;
      }
      const engagementEndMs = action.atMs + OPERATOR_ENGAGEMENT_MS;
      const engagementActive = engagementEndMs > now;
      observations.push({
        source: { engine: action.engine, lastActivityAtMs: action.atMs },
        streamKey: action.key,
        project: action.project,
        window: { startedAt: action.atMs, endedAt: engagementActive ? null : engagementEndMs },
        openWindowActive: engagementActive,
        respectEnabledAt: false,
      });
      if (!engagementActive) acknowledgeable.push(action.key);
    }

    let scan: { files: FileEntry[]; complete: boolean } = { files: [], complete: false };
    try {
      scan = await deps.scan();
    } catch {
      report("observation_failed");
    }
    if (scan.complete) {
      try {
        const registry = deps.registrySnapshot();
        const lookup = conversationLookupFromSnapshot(registry);
        for (const entry of scan.files) {
          if ((entry.engine !== "claude" && entry.engine !== "codex")
            || (entry.root !== "claude-projects" && entry.root !== "codex-sessions")
            || !entry.path.endsWith(".jsonl") || entry.derivationComplete !== true) continue;
          const conversation = lookup.conversationForPath(entry.path);
          const generation = conversation?.generations.at(-1);
          if (!conversation || !generation || generation.path !== entry.path || conversation.engine !== entry.engine) continue;
          const recent = deps.recentTurnWindows(entry);
          if (!recent.complete) continue;
          if (recent.prefixTruncated && !historyGapPaths.has(entry.path)) {
            historyGapPaths.add(entry.path);
            current.counters.historyGaps += 1;
            report("history_gap", { count: current.counters.historyGaps });
          }
          const project = resolveProjectAttribution({
            projectOwnership: conversation.projectOwnership,
            cwd: generation.launchProfile.cwd || entry.cwd,
            launchProfileProject: generation.launchProfile.project,
            fallbackProject: entry.project,
          }).project;
          if (!project) continue;
          const openWindowActive = openTurnIsActive(entry);
          for (const window of recent.windows) {
            observations.push({
              source: { engine: entry.engine, lastActivityAtMs: entry.mtime * 1_000 },
              streamKey: turnDigest(conversation.id, window.startedAt),
              project,
              window,
              openWindowActive,
              respectEnabledAt: true,
            });
          }
        }
      } catch {
        report("observation_failed");
      }
    }
    const effectiveEnd = (observation: typeof observations[number]): number => {
      if (observation.window.endedAt !== null) return observation.window.endedAt;
      if (observation.openWindowActive) return now;
      return Math.min(now, Math.max(
        observation.window.startedAt,
        observation.source.lastActivityAtMs,
        current.streams[observation.streamKey]?.lastObservedAtMs ?? observation.window.startedAt,
      ));
    };
    const effectiveEnds = observations.map(effectiveEnd);
    const coveredBySameProject = new Array<boolean>(observations.length).fill(false);
    const observationsByProject = new Map<string, number[]>();
    for (let index = 0; index < observations.length; index += 1) {
      const indexes = observationsByProject.get(observations[index]!.project) ?? [];
      indexes.push(index);
      observationsByProject.set(observations[index]!.project, indexes);
    }
    for (const indexes of observationsByProject.values()) {
      const candidates = [...indexes].sort((left, right) =>
        observations[left]!.window.startedAt - observations[right]!.window.startedAt);
      const queries = indexes
        .filter((index) => observations[index]!.window.endedAt !== null || !observations[index]!.openWindowActive)
        .sort((left, right) => effectiveEnds[left]! - effectiveEnds[right]!);
      let candidateIndex = 0;
      let maximumEnd = Number.NEGATIVE_INFINITY;
      let activeAtMaximumEnd = false;
      for (const query of queries) {
        const queryEnd = effectiveEnds[query]!;
        while (
          candidateIndex < candidates.length
          && observations[candidates[candidateIndex]!]!.window.startedAt <= queryEnd
        ) {
          const candidate = candidates[candidateIndex]!;
          const candidateEnd = effectiveEnds[candidate]!;
          const activeOpen = observations[candidate]!.window.endedAt === null
            && observations[candidate]!.openWindowActive;
          if (candidateEnd > maximumEnd) {
            maximumEnd = candidateEnd;
            activeAtMaximumEnd = activeOpen;
          } else if (candidateEnd === maximumEnd && activeOpen) {
            activeAtMaximumEnd = true;
          }
          candidateIndex += 1;
        }
        coveredBySameProject[query] = maximumEnd > queryEnd
          || (maximumEnd === queryEnd && activeAtMaximumEnd);
      }
    }
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index]!;
      addWindow(
        current,
        observation.source,
        observation.streamKey,
        observation.project,
        observation.window,
        now,
        existingKeys,
        observation.openWindowActive,
        !coveredBySameProject[index],
        observation.respectEnabledAt,
      );
    }
    return acknowledgeable;
  };

  const setRetry = (
    current: WakatimeStateV1,
    reason: Exclude<WakatimeStateV1["retry"]["reason"], null>,
    retryAfter: number = 0,
    status: number | null = null,
  ) => {
    current.retry.failures += 1;
    const delay = reason === "auth"
      ? AUTH_RETRY_MS
      : Math.max(retryDelayMs(current.retry.failures, deps.random()), retryAfter);
    current.retry.reason = reason;
    current.retry.retryAtMs = deps.now() + delay;
    report(`${reason}_backoff`, { failures: current.retry.failures, retryAtMs: current.retry.retryAtMs, status });
  };

  const deliver = async (current: WakatimeStateV1): Promise<void> => {
    if (current.pending.length === 0) return;
    const credential = await deps.readCredential();
    if (!credential?.value.trim()) {
      missingCredential = true;
      report("missing_credential", { pending: current.pending.length });
      return;
    }
    if (missingCredential) {
      missingCredential = false;
      report("credential_recovered", { pending: current.pending.length }, true);
    }
    const currentCredentialGeneration = credentialGeneration(credential.sourceStamp);
    if (current.credentialGeneration !== currentCredentialGeneration) {
      if (current.retry.reason === "auth") current.retry = { failures: 0, retryAtMs: 0, reason: null };
      current.credentialGeneration = currentCredentialGeneration;
      if (!await persist(current)) return;
    }
    if (current.retry.retryAtMs > deps.now()) return;

    const batch = current.pending.slice(0, MAX_BATCH);
    const controller = new AbortController();
    abortController = controller;
    let timedOut = false;
    const timeout = deps.scheduleTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response: WakatimeResponse;
    let responseBody: string | null = null;
    try {
      response = await deps.fetch(ENDPOINT, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Basic ${base64(credential.value.trim())}`,
          "Content-Type": "application/json",
          "User-Agent": "agent-log-viewer-wakatime/1",
        },
        body: JSON.stringify(batch.map((event) => event.heartbeat)),
        signal: controller.signal,
      });
      if (response.status === 201 || response.status === 202) responseBody = await response.text();
    } catch {
      setRetry(current, timedOut ? "timeout" : "network");
      await persist(current);
      return;
    } finally {
      deps.clearTimer(timeout);
      if (abortController === controller) abortController = null;
    }

    if (response.status === 201 || response.status === 202) {
      const statuses = bulkResponseStatuses(responseBody ?? "", batch.length);
      if (!statuses) {
        report("malformed_bulk_response", { status: response.status, expected: batch.length });
        setRetry(current, "server", 0, response.status);
        await persist(current);
        return;
      }
      const acknowledged = new Set<string>();
      let accepted = 0;
      let permanentlyRejected = 0;
      let retryReason: Exclude<WakatimeStateV1["retry"]["reason"], null> | null = null;
      let retryStatus: number | null = null;
      for (let index = 0; index < statuses.length; index += 1) {
        const status = statuses[index]!;
        const itemReason = retryReasonForItem(status);
        if (status >= 200 && status < 300) {
          acknowledged.add(batch[index]!.key);
          accepted += 1;
        } else if (itemReason) {
          if (retryReason === null || itemReason === "auth" || (itemReason === "rate_limit" && retryReason === "server")) {
            retryReason = itemReason;
            retryStatus = status;
          }
        } else {
          acknowledged.add(batch[index]!.key);
          permanentlyRejected += 1;
        }
      }
      current.pending = current.pending.filter((event) => !acknowledged.has(event.key));
      current.counters.accepted += accepted;
      current.counters.permanentlyRejected += permanentlyRejected;
      if (permanentlyRejected > 0) report("permanent_rejection", { status: null, count: permanentlyRejected });
      const previousReason = current.retry.reason;
      if (retryReason) setRetry(current, retryReason, 0, retryStatus);
      else current.retry = { failures: 0, retryAtMs: 0, reason: null };
      if (previousReason && !retryReason) report("delivery_recovered", { accepted }, true);
      await persist(current);
      return;
    }
    if (response.status === 302 || response.status === 429) {
      setRetry(current, "rate_limit", retryAfterMs(response.headers.get("retry-after"), deps.now()), response.status);
      await persist(current);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      setRetry(current, "auth", 0, response.status);
      await persist(current);
      return;
    }
    if (response.status === 408 || response.status === 409 || response.status === 425) {
      setRetry(current, "server", 0, response.status);
      await persist(current);
      return;
    }
    if (response.status >= 500 && response.status < 600) {
      setRetry(current, "server", 0, response.status);
      await persist(current);
      return;
    }
    if (response.status >= 400 && response.status < 500) {
      const keys = new Set(batch.map((event) => event.key));
      current.pending = current.pending.filter((event) => !keys.has(event.key));
      current.counters.permanentlyRejected += batch.length;
      current.retry = { failures: 0, retryAtMs: 0, reason: null };
      report("permanent_rejection", { status: response.status, count: batch.length });
      await persist(current);
      return;
    }
    setRetry(current, "network");
    await persist(current);
  };

  const run = async (): Promise<void> => {
    const current = await load();
    let acknowledgeableOperatorActions: string[];
    try {
      acknowledgeableOperatorActions = await observe(current);
    } catch {
      report("observation_failed");
      return;
    }
    const beforeCompacted = current.counters.compacted;
    const beforeDropped = current.counters.dropped;
    enforceBounds(current, deps.now(), maxPending, maxStreams);
    if (current.counters.compacted !== beforeCompacted || current.counters.dropped !== beforeDropped) {
      report("queue_bounded", {
        compacted: current.counters.compacted - beforeCompacted,
        dropped: current.counters.dropped - beforeDropped,
        pending: current.pending.length,
      });
    }
    if (!await persist(current)) return;
    const settledOperatorActions = acknowledgeableOperatorActions.filter((key) => {
      const stream = current.streams[key];
      return Boolean(current.retiredStreams?.[key])
        || (stream !== undefined && stream.endedAtMs !== null && stream.lastMaterializedAtMs >= stream.endedAtMs);
    });
    if (settledOperatorActions.length > 0) {
      try {
        await deps.acknowledgeOperatorActions?.(settledOperatorActions);
      } catch {
        report("operator_activity_ack_failed");
      }
    }
    try {
      await deliver(current);
    } catch {
      report("delivery_failed");
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    try {
      if (schedulerLease && !schedulerLease.isHeld()) {
        schedulerLease.release();
        schedulerLease = null;
      }
      schedulerLease ??= deps.acquireSchedulerLease();
      if (!schedulerLease?.isHeld()) return Promise.resolve();
    } catch {
      report("scheduler_lease_failed");
      return Promise.resolve();
    }
    if (running) {
      trailing = true;
      return running;
    }
    running = run().catch(() => report("tick_failed"));
    const result = running;
    void result.finally(() => {
      running = null;
      if (trailing && !stopped) {
        trailing = false;
        void tick();
      }
    });
    return result;
  };

  const initialTimer = deps.scheduleTimeout(() => { void tick(); }, 0);
  initialTimer.unref?.();
  const intervalTimer = deps.scheduleInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  intervalTimer.unref?.();
  void Promise.resolve()
    .then(() => deps.readCredential())
    .then(
      (credential) => report("enabled", { credentialPresent: Boolean(credential?.value.trim()) }, true),
      () => report("enabled", { credentialPresent: false }, true),
    );

  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      trailing = false;
      deps.clearTimer(initialTimer);
      deps.clearTimer(intervalTimer);
      abortController?.abort();
      const releaseSchedulerLease = () => {
        schedulerLease?.release();
        schedulerLease = null;
      };
      if (running) void running.finally(releaseSchedulerLease);
      else releaseSchedulerLease();
    },
  };
}

/** Opens the configured key without following symlinks and verifies its mode
    before reading credential bytes into integration-owned memory. */
export function readWakatimeCredentialFile(filename: string): WakatimeCredential | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return null;
    const value = fs.readFileSync(descriptor, "utf8").trim();
    return value
      ? { value, sourceStamp: `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function readProductionWakatimeCredential(
  filename: string = configFilePath("wakatime-api-key"),
): WakatimeCredential | null {
  return readWakatimeCredentialFile(filename);
}

function readProductionState(): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(statePath("wakatime-state.json"), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeProductionState(state: WakatimeStateV1): void {
  const filename = statePath("wakatime-state.json");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename or cleanup already completed */ }
  }
}

const singleton = globalThis as typeof globalThis & { __llvWakatimeSync?: WakatimeSync };

const INCOMPLETE_WAKATIME_SCAN: FileScanSnapshot = {
  files: [],
  projectCatalog: [],
  complete: false,
};

export async function wakatimeProductionScan(
  env: Readonly<Record<string, string | undefined>> = process.env,
  persisted: () => FileScanSnapshot | undefined = persistedFileScanSnapshot,
  live: typeof currentFileScan = currentFileScan,
): Promise<FileScanSnapshot> {
  if (env.LLV_WAKATIME_SYNC_WORKER === "1") {
    return persisted() ?? INCOMPLETE_WAKATIME_SCAN;
  }
  return (await live()).snapshot;
}

function productionDependencies(): WakatimeSyncDependencies {
  return {
    scan: () => wakatimeProductionScan(),
    registrySnapshot: () => agentRegistry().readOnlySnapshot(),
    recentTurnWindows: recentTurnWindowsFor,
    readOperatorActions: readDirectOperatorWakatimeActions,
    acknowledgeOperatorActions: acknowledgeDirectOperatorWakatimeActions,
    readCredential: readProductionWakatimeCredential,
    readState: readProductionState,
    writeState: writeProductionState,
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    random: Math.random,
    scheduleInterval: (callback, delayMs) => setInterval(callback, delayMs),
    scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    acquireSchedulerLease: () => acquireWakatimeSchedulerLease(statePath("wakatime-scheduler-owner.json")),
    logger: (event, fields) => console.error(`[wakatime] ${event}`, fields),
  };
}

export function startWakatimeSync(dependencies: WakatimeSyncDependencies = productionDependencies()): void {
  if (singleton.__llvWakatimeSync) return;
  const sync = createWakatimeSync(dependencies);
  singleton.__llvWakatimeSync = sync;
}
