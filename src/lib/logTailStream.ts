import fs from "node:fs";
import fsp from "node:fs/promises";

import { readTailChunk as defaultReadTailChunk } from "@/lib/logRead";
import { MAX_CHUNK } from "@/lib/scanner/roots";
import type { ApiError, LogChunk } from "@/lib/types";

export const MAX_STREAM_SUBS = 64;
export const STREAM_BATCH_BUDGET = 4 * MAX_CHUNK;
const DEFAULT_RESTAT_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_CATCH_UP_DELAY_MS = 0;

export interface LogStreamSub {
  id: string;
  path: string;
  offset: number;
}

export type LogTailStreamResult = LogChunk | ApiError;

export interface LogTailStreamEvent {
  id: string;
  chunk: LogTailStreamResult;
}

type WatchHandle = { close(): void };
type WatchFile = (pathname: string, onChange: () => void) => WatchHandle;
type ReadTail = typeof defaultReadTailChunk;

export interface LogTailStreamOptions {
  signal?: AbortSignal;
  batchBudget?: number;
  restatMs?: number;
  heartbeatMs?: number;
  catchUpDelayMs?: number;
  readTailChunk?: ReadTail;
  watchFile?: WatchFile;
  onEvent: (event: LogTailStreamEvent) => void;
  onComment?: (comment: string) => void;
}

interface TailState {
  id: string;
  path: string;
  offset: number;
  size: number | null;
  initial: boolean;
  watcher: WatchHandle | null;
}

function defaultWatchFile(pathname: string, onChange: () => void): WatchHandle {
  return fs.watch(pathname, () => onChange());
}

export function parseLogStreamSubs(raw: string | null): LogStreamSub[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LogStreamSub[] = [];
  for (const entry of parsed.slice(0, MAX_STREAM_SUBS)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, path, offset } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof path !== "string") continue;
    out.push({ id, path, offset: typeof offset === "number" ? offset : 0 });
  }
  return out;
}

export class LogTailStreamSession {
  private readonly states: TailState[];
  private readonly pending = new Set<TailState>();
  private readonly readTailChunk: ReadTail;
  private readonly watchFile: WatchFile;
  private readonly onEvent: (event: LogTailStreamEvent) => void;
  private readonly onComment?: (comment: string) => void;
  private readonly batchBudget: number;
  private readonly restatMs: number;
  private readonly heartbeatMs: number;
  private readonly catchUpDelayMs: number;
  private readonly signal?: AbortSignal;
  private readonly abort = () => this.close();

  private restatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private pumping = false;
  private closed = false;

  constructor(subs: LogStreamSub[], options: LogTailStreamOptions) {
    this.states = subs.slice(0, MAX_STREAM_SUBS).map((sub) => ({
      id: sub.id,
      path: sub.path,
      offset: Number.isFinite(sub.offset) && sub.offset >= 0 ? sub.offset : 0,
      size: null,
      initial: true,
      watcher: null,
    }));
    this.readTailChunk = options.readTailChunk ?? defaultReadTailChunk;
    this.watchFile = options.watchFile ?? defaultWatchFile;
    this.onEvent = options.onEvent;
    this.onComment = options.onComment;
    this.batchBudget = options.batchBudget ?? STREAM_BATCH_BUDGET;
    this.restatMs = options.restatMs ?? DEFAULT_RESTAT_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.catchUpDelayMs = options.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS;
    this.signal = options.signal;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.signal?.aborted) {
      this.close();
      return;
    }
    this.signal?.addEventListener("abort", this.abort, { once: true });
    this.heartbeatTimer = setInterval(() => {
      if (!this.closed) this.onComment?.("heartbeat");
    }, this.heartbeatMs);
    this.restatTimer = setInterval(() => {
      void this.restat();
    }, this.restatMs);
    for (const state of this.states) this.queue(state);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.restatTimer) clearInterval(this.restatTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pumpTimer = null;
    this.restatTimer = null;
    this.heartbeatTimer = null;
    for (const state of this.states) {
      state.watcher?.close();
      state.watcher = null;
    }
    this.signal?.removeEventListener("abort", this.abort);
  }

  private queue(state: TailState): void {
    if (this.closed) return;
    this.pending.add(state);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.closed || this.pumping || this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.pump();
    }, this.catchUpDelayMs);
  }

  private async pump(): Promise<void> {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    let budget = this.batchBudget;
    const cycle = [...this.pending];
    this.pending.clear();
    try {
      for (const state of cycle) {
        if (this.closed) return;
        const spent = await this.readState(state, budget);
        budget = Math.max(0, budget - spent);
      }
    } finally {
      this.pumping = false;
      if (!this.closed && this.pending.size > 0) this.schedulePump();
    }
  }

  private async readState(state: TailState, budget: number): Promise<number> {
    const previousOffset = state.offset;
    let chunk: LogChunk | null;
    try {
      chunk = await this.readTailChunk(state.path, state.offset, budget);
    } catch {
      if (!this.closed) {
        state.initial = false;
        this.onEvent({ id: state.id, chunk: { error: "failed to read log" } });
      }
      return 0;
    }
    if (this.closed) return 0;
    if (!chunk) {
      state.initial = false;
      this.onEvent({ id: state.id, chunk: { error: "path not allowed" } });
      return 0;
    }

    state.offset = chunk.offset;
    state.size = chunk.size;
    if (!state.watcher) this.openWatcher(state);

    const spent = Math.max(0, chunk.offset - chunk.start);
    if (state.initial || chunk.data.length > 0 || previousOffset > chunk.size) {
      state.initial = false;
      this.onEvent({ id: state.id, chunk });
    } else {
      state.initial = false;
    }
    if (chunk.offset < chunk.size) this.pending.add(state);
    return spent;
  }

  private openWatcher(state: TailState): void {
    try {
      state.watcher = this.watchFile(state.path, () => this.queue(state));
    } catch {
      state.watcher = null;
    }
  }

  private async restat(): Promise<void> {
    if (this.closed) return;
    for (const state of this.states) {
      if (this.closed) continue;
      let stat;
      try {
        stat = await fsp.stat(state.path);
      } catch {
        stat = null;
      }
      if (!stat?.isFile()) {
        this.queue(state);
        continue;
      }
      if (!state.watcher || state.size === null || stat.size !== state.size || stat.size < state.offset) this.queue(state);
    }
  }
}

const encoder = new TextEncoder();

function encodeChunk(event: LogTailStreamEvent): Uint8Array {
  return encoder.encode(`event: chunk\ndata: ${JSON.stringify(event)}\n\n`);
}

function encodeComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export function createLogTailEventStream(subs: LogStreamSub[], signal?: AbortSignal): ReadableStream<Uint8Array> {
  let session: LogTailStreamSession | null = null;
  let stopped = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (payload: Uint8Array) => {
        if (stopped) return;
        /* A stale SSE response can outlive its browser connection under the
           production Next/Bun adapter. Stop at the first queued chunk: the
           EventSource reconnect resumes from the browser's durable offset,
           while an abandoned response cannot buffer transcript data forever. */
        if ((controller.desiredSize ?? 1) <= 0) {
          stopped = true;
          session?.close();
          try { controller.close(); } catch { /* response already closed */ }
          return;
        }
        try {
          controller.enqueue(payload);
        } catch {
          stopped = true;
          session?.close();
        }
      };
      session = new LogTailStreamSession(subs, {
        signal,
        onEvent: (event) => enqueue(encodeChunk(event)),
        onComment: (comment) => enqueue(encodeComment(comment)),
      });
      session.start();
    },
    cancel() {
      stopped = true;
      session?.close();
      session = null;
    },
  });
}
