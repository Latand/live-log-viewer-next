"use client";

/* eslint-disable react-hooks/exhaustive-deps */

import { useCallback, useEffect, useRef, useState } from "react";

import { getLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { LogChunk } from "@/lib/types";

import { subscribeLog } from "./logBus";

/** Longest single jsonl line we are willing to chase across history chunks. */
const OLDER_CHUNK_HOPS = 4;
const TAIL_CACHE_PATHS = 24;
const TAIL_CACHE_LINES = 6000;

const utf8len = (text: string) => new TextEncoder().encode(text).length;

interface TailSnapshot {
  win: { lines: string[]; start: number };
  size: number;
  offset: number;
  historyStart: number;
  partial: string;
  first: boolean;
  hasMore: boolean;
  tickTime: Date | null;
}

/* Browser-wide tail snapshots keep revisited projects useful on their first
   paint. Entries retain the transport offset and partial-line decoder state,
   so the live subscription continues forward without duplicating cached rows. */
const tailCache = new Map<string, TailSnapshot>();

export function resetLogTailCacheForTests(): void {
  tailCache.clear();
}

function boundedSnapshot(snapshot: TailSnapshot, cap: number): TailSnapshot {
  const limit = cap > 0 ? Math.min(cap, TAIL_CACHE_LINES) : TAIL_CACHE_LINES;
  if (snapshot.win.lines.length <= limit) return snapshot;
  const removed = snapshot.win.lines.slice(0, snapshot.win.lines.length - limit);
  const removedBytes = removed.reduce((total, line) => total + utf8len(line + "\n"), 0);
  return {
    ...snapshot,
    win: {
      lines: snapshot.win.lines.slice(-limit),
      start: snapshot.win.start + removed.length,
    },
    historyStart: snapshot.historyStart + removedBytes,
    hasMore: true,
  };
}

function readTailCache(path: string, cap: number): TailSnapshot | null {
  const cached = tailCache.get(path);
  if (!cached) return null;
  tailCache.delete(path);
  const bounded = boundedSnapshot(cached, cap);
  tailCache.set(path, bounded);
  return bounded;
}

function writeTailCache(path: string, snapshot: TailSnapshot): void {
  tailCache.delete(path);
  tailCache.set(path, boundedSnapshot(snapshot, TAIL_CACHE_LINES));
  while (tailCache.size > TAIL_CACHE_PATHS) {
    const oldest = tailCache.keys().next().value as string | undefined;
    if (!oldest) break;
    tailCache.delete(oldest);
  }
}

export interface LogTailState {
  lines: string[];
  /** Absolute index of `lines[0]` in the tail stream: grows as the cap trims
      the front, goes negative when history is prepended. Feed sessions use it
      to parse only lines they have not seen. */
  linesStart: number;
  size: number;
  loading: boolean;
  error: string | null;
  tickTime: Date | null;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  clear: () => void;
  /** Bytes of history exist before the loaded window. */
  hasMore: boolean;
  loadingOlder: boolean;
  /** Prepend one older chunk of complete lines; resolves to the line count added. */
  loadOlder: () => Promise<number>;
  /** Increments on every prepend, for scroll anchoring. */
  prependGen: number;
}

/** What the hook renders for one transcript, tagged with that transcript's
    path so a switch can never show one conversation's lines under another's
    title (#1432). */
interface TailView {
  path: string | null;
  win: { lines: string[]; start: number };
  size: number;
  loading: boolean;
  error: string | null;
  tickTime: Date | null;
  hasMore: boolean;
}

function viewFor(file: FileEntry | null, cap: number): TailView {
  const cached = file ? readTailCache(file.path, cap) : null;
  return {
    path: file?.path ?? null,
    win: cached?.win ?? { lines: [], start: 0 },
    size: cached?.size ?? file?.size ?? 0,
    loading: Boolean(file && !cached),
    error: null,
    tickTime: cached?.tickTime ?? null,
    hasMore: cached?.hasMore ?? false,
  };
}

/**
 * Forward tail polling plus on-demand backward history: `lines` always hold a
 * contiguous window ending at the live tail; `loadOlder` extends the window
 * toward the file start one chunk at a time. `cap` trims old lines on append
 * (dashboard columns); 0 keeps everything. The value may change between
 * renders — the caller drops the cap while the reader scrolled up, so
 * trimming never shifts what is being read.
 */
export function useLogTail(file: FileEntry | null, pausedInput = false, cap = 2500): LogTailState {
  const path = file?.path ?? null;
  const capRef = useRef(cap);
  const [view, setView] = useState<TailView>(() => viewFor(file, cap));
  /* The window follows the path IN THE SAME RENDER (#1432). Re-seating it from
     an effect painted the previous conversation's lines under the new file for
     a frame — and parsed them for nothing — before the cached window (or the
     empty loading state) replaced them. Set-state-in-render on the hook's own
     state is React's sanctioned form of this: the render restarts at once with
     the switched window and nothing below ever sees the mismatch. */
  if (view.path !== path) setView(viewFor(file, capRef.current));
  const [paused, setPaused] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [prependGen, setPrependGen] = useState(0);
  /* Transport state lives in refs, re-seated by the path effect below from
     the same cached snapshot the render switched to. */
  const winRef = useRef(view.win);
  const sizeRef = useRef(view.size);
  const tickTimeRef = useRef<Date | null>(view.tickTime);
  const hasMoreRef = useRef(view.hasMore);
  const offsetRef = useRef(0);
  const startRef = useRef(0);
  const tailRef = useRef("");
  const firstRef = useRef(true);
  const genRef = useRef(0);
  const olderBusyRef = useRef(false);

  useEffect(() => {
    capRef.current = cap;
  }, [cap]);

  /* Every state write names the transcript it is for: a chunk or a history
     page that lands after the pane switched away is dropped, never merged
     into the newer conversation's window. */
  const patch = (target: string | null, next: Partial<Omit<TailView, "path">>) => {
    setView((prev) => (prev.path === target ? { ...prev, ...next } : prev));
  };

  const updateWin = (target: string | null, next: { lines: string[]; start: number }) => {
    winRef.current = next;
    patch(target, { win: next });
  };

  const updateHasMore = (target: string | null, next: boolean) => {
    hasMoreRef.current = next;
    patch(target, { hasMore: next });
  };

  const saveSnapshot = (target: string) => {
    writeTailCache(target, {
      win: winRef.current,
      size: sizeRef.current,
      offset: offsetRef.current,
      historyStart: startRef.current,
      partial: tailRef.current,
      first: firstRef.current,
      hasMore: hasMoreRef.current,
      tickTime: tickTimeRef.current,
    });
  };

  const resetWindow = (target: string | null) => {
    offsetRef.current = 0;
    startRef.current = 0;
    tailRef.current = "";
    firstRef.current = true;
    updateHasMore(target, false);
  };

  const clear = useCallback(() => {
    if (path) tailCache.delete(path);
    updateWin(path, { lines: [], start: 0 });
    resetWindow(path);
  }, [path]);

  useEffect(() => {
    genRef.current += 1;
    /* The rendered window already switched (see the render above); the
       transport state — offset, history start, decoder partial — is re-seated
       here from the same snapshot, so the live subscription continues forward
       from where the cached window ends instead of re-reading it. */
    const cached = path ? readTailCache(path, capRef.current) : null;
    winRef.current = cached?.win ?? { lines: [], start: 0 };
    offsetRef.current = cached?.offset ?? 0;
    startRef.current = cached?.historyStart ?? 0;
    tailRef.current = cached?.partial ?? "";
    firstRef.current = cached?.first ?? true;
    hasMoreRef.current = cached?.hasMore ?? false;
    sizeRef.current = cached?.size ?? file?.size ?? 0;
    tickTimeRef.current = cached?.tickTime ?? null;
  }, [path]);

  /* Forward polling rides the shared log bus: one batched request per tick
     for every mounted pane. A paused pane unsubscribes entirely — the server
     must not keep re-reading bytes nobody consumes — and resuming triggers
     the bus's immediate tick, so catch-up beats the old fixed interval. */
  useEffect(() => {
    if (!path || paused || pausedInput) return;
    const target = path;
    let alive = true;
    const gen = genRef.current;
    const unsubscribe = subscribeLog({
      path: target,
      getOffset: () => offsetRef.current,
      onChunk: (result) => {
        if (!alive || gen !== genRef.current) return;
        if ("transportError" in result) {
          patch(target, { error: translate(getLocale(), "common.serverUnavailable"), loading: false });
          return;
        }
        if ("error" in result && result.error) {
          patch(target, { error: result.error, loading: false });
          return;
        }
        const chunk = result as LogChunk;
        if (offsetRef.current > chunk.size) {
          resetWindow(target);
          updateWin(target, { lines: [], start: 0 });
        }
        if (chunk.data) {
          let data = tailRef.current + chunk.data;
          tailRef.current = "";
          if (firstRef.current) {
            startRef.current = chunk.start;
            if (chunk.start > 0) {
              const nl = data.indexOf("\n");
              startRef.current = chunk.start + (nl >= 0 ? utf8len(data.slice(0, nl + 1)) : utf8len(data));
              data = nl >= 0 ? data.slice(nl + 1) : "";
            }
            updateHasMore(target, startRef.current > 0);
          }
          const parts = data.split("\n");
          tailRef.current = parts.pop() ?? "";
          const complete = parts.map((line) => line.trim()).filter(Boolean);
          if (offsetRef.current === 0) updateWin(target, { lines: complete, start: 0 });
          else if (complete.length) {
            const prev = winRef.current;
            const merged = prev.lines.concat(complete);
            const capNow = capRef.current;
            updateWin(target, capNow > 0 && merged.length > capNow
              ? { lines: merged.slice(-capNow), start: prev.start + (merged.length - capNow) }
              : { lines: merged, start: prev.start });
          }
          firstRef.current = false;
        }
        offsetRef.current = chunk.offset;
        sizeRef.current = chunk.size;
        const next: Partial<Omit<TailView, "path">> = { size: chunk.size, error: null, loading: false };
        /* Idle polls must not re-render every pane every 1.2s: the tick time
           moves only when bytes actually arrived (status reads "last data"). */
        if (chunk.data) {
          tickTimeRef.current = new Date();
          next.tickTime = tickTimeRef.current;
        }
        patch(target, next);
        saveSnapshot(target);
      },
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [path, paused, pausedInput]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!path || olderBusyRef.current || startRef.current <= 0) return 0;
    const target = path;
    olderBusyRef.current = true;
    setLoadingOlder(true);
    const gen = genRef.current;
    try {
      let text = "";
      let start = startRef.current;
      // A chunk may end mid-line; hop further back until the first newline shows up.
      for (let hop = 0; hop < OLDER_CHUNK_HOPS; hop += 1) {
        const res = await fetch(`/api/log?path=${encodeURIComponent(target)}&before=${start}`);
        const json = (await res.json()) as LogChunk | { error?: string };
        if (gen !== genRef.current) return 0;
        if ("error" in json && json.error) return 0;
        const chunk = json as LogChunk;
        text = chunk.data + text;
        start = chunk.start;
        /* The chunk ends at a known line boundary, so the trailing newline is
           always there; progress needs one that CLOSES a line inside the chunk. */
        if (start === 0 || text.slice(0, -1).includes("\n")) break;
      }
      let newStart = start;
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl < 0 || nl === text.length - 1) return 0;
        newStart = start + utf8len(text.slice(0, nl + 1));
        text = text.slice(nl + 1);
      }
      const parts = text.split("\n");
      if (parts.at(-1) === "") parts.pop();
      const complete = parts.map((line) => line.trim()).filter(Boolean);
      startRef.current = newStart;
      updateHasMore(target, newStart > 0);
      if (complete.length) {
        const prev = winRef.current;
        updateWin(target, { lines: complete.concat(prev.lines), start: prev.start - complete.length });
        setPrependGen((value) => value + 1);
      }
      saveSnapshot(target);
      return complete.length;
    } catch {
      return 0;
    } finally {
      olderBusyRef.current = false;
      setLoadingOlder(false);
    }
  }, [path]);

  return {
    lines: view.win.lines,
    linesStart: view.win.start,
    size: view.size,
    loading: view.loading,
    error: view.error,
    tickTime: view.tickTime,
    paused,
    setPaused,
    clear,
    hasMore: view.hasMore,
    loadingOlder,
    loadOlder,
    prependGen,
  };
}
