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

/**
 * Forward tail polling plus on-demand backward history: `lines` always hold a
 * contiguous window ending at the live tail; `loadOlder` extends the window
 * toward the file start one chunk at a time. `cap` trims old lines on append
 * (dashboard columns); 0 keeps everything. The value may change between
 * renders — the caller drops the cap while the reader scrolled up, so
 * trimming never shifts what is being read.
 */
export function useLogTail(file: FileEntry | null, pausedInput = false, cap = 2500): LogTailState {
  const [initialSnapshot] = useState(() => file ? readTailCache(file.path, cap) : null);
  const initialWin = initialSnapshot?.win ?? { lines: [], start: 0 };
  const capRef = useRef(cap);
  /* One atomic window state: the lines plus the absolute index of lines[0],
     updated together so a trim and its start shift can never tear. */
  const [win, setWin] = useState<{ lines: string[]; start: number }>(initialWin);
  const [size, setSize] = useState(initialSnapshot?.size ?? 0);
  const [loading, setLoading] = useState(Boolean(file && !initialSnapshot));
  const [error, setError] = useState<string | null>(null);
  const [tickTime, setTickTime] = useState<Date | null>(initialSnapshot?.tickTime ?? null);
  const [paused, setPaused] = useState(false);
  const [hasMore, setHasMore] = useState(initialSnapshot?.hasMore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [prependGen, setPrependGen] = useState(0);
  const winRef = useRef(initialWin);
  const sizeRef = useRef(initialSnapshot?.size ?? 0);
  const tickTimeRef = useRef<Date | null>(initialSnapshot?.tickTime ?? null);
  const hasMoreRef = useRef(initialSnapshot?.hasMore ?? false);
  const offsetRef = useRef(initialSnapshot?.offset ?? 0);
  const startRef = useRef(initialSnapshot?.historyStart ?? 0);
  const tailRef = useRef(initialSnapshot?.partial ?? "");
  const firstRef = useRef(initialSnapshot?.first ?? true);
  const genRef = useRef(0);
  const olderBusyRef = useRef(false);

  useEffect(() => {
    capRef.current = cap;
  }, [cap]);

  const updateWin = (next: { lines: string[]; start: number }) => {
    winRef.current = next;
    setWin(next);
  };

  const updateHasMore = (next: boolean) => {
    hasMoreRef.current = next;
    setHasMore(next);
  };

  const saveSnapshot = (path: string) => {
    writeTailCache(path, {
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

  const resetWindow = () => {
    offsetRef.current = 0;
    startRef.current = 0;
    tailRef.current = "";
    firstRef.current = true;
    updateHasMore(false);
  };

  const clear = useCallback(() => {
    if (file) tailCache.delete(file.path);
    updateWin({ lines: [], start: 0 });
    resetWindow();
  }, [file?.path]);

  useEffect(() => {
    genRef.current += 1;
    const cached = file ? readTailCache(file.path, capRef.current) : null;
    const nextWin = cached?.win ?? { lines: [], start: 0 };
    winRef.current = nextWin;
    offsetRef.current = cached?.offset ?? 0;
    startRef.current = cached?.historyStart ?? 0;
    tailRef.current = cached?.partial ?? "";
    firstRef.current = cached?.first ?? true;
    hasMoreRef.current = cached?.hasMore ?? false;
    sizeRef.current = cached?.size ?? file?.size ?? 0;
    tickTimeRef.current = cached?.tickTime ?? null;
    setWin(nextWin);
    setHasMore(hasMoreRef.current);
    setSize(sizeRef.current);
    setTickTime(tickTimeRef.current);
    setError(null);
    setLoading(Boolean(file && !cached));
  }, [file?.path]);

  /* Forward polling rides the shared log bus: one batched request per tick
     for every mounted pane. A paused pane unsubscribes entirely — the server
     must not keep re-reading bytes nobody consumes — and resuming triggers
     the bus's immediate tick, so catch-up beats the old fixed interval. */
  useEffect(() => {
    if (!file || paused || pausedInput) return;
    let alive = true;
    const gen = genRef.current;
    const unsubscribe = subscribeLog({
      path: file.path,
      getOffset: () => offsetRef.current,
      onChunk: (result) => {
        if (!alive || gen !== genRef.current) return;
        if ("transportError" in result) {
          setError(translate(getLocale(), "common.serverUnavailable"));
          setLoading(false);
          return;
        }
        if ("error" in result && result.error) {
          setError(result.error);
          setLoading(false);
          return;
        }
        const chunk = result as LogChunk;
        if (offsetRef.current > chunk.size) {
          resetWindow();
          updateWin({ lines: [], start: 0 });
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
            updateHasMore(startRef.current > 0);
          }
          const parts = data.split("\n");
          tailRef.current = parts.pop() ?? "";
          const complete = parts.map((line) => line.trim()).filter(Boolean);
          if (offsetRef.current === 0) updateWin({ lines: complete, start: 0 });
          else if (complete.length) {
            const prev = winRef.current;
            const merged = prev.lines.concat(complete);
            const capNow = capRef.current;
            updateWin(capNow > 0 && merged.length > capNow
              ? { lines: merged.slice(-capNow), start: prev.start + (merged.length - capNow) }
              : { lines: merged, start: prev.start });
          }
          firstRef.current = false;
        }
        offsetRef.current = chunk.offset;
        sizeRef.current = chunk.size;
        setSize(chunk.size);
        setError(null);
        /* Idle polls must not re-render every pane every 1.2s: the tick time
           moves only when bytes actually arrived (status reads "last data"). */
        if (chunk.data) {
          tickTimeRef.current = new Date();
          setTickTime(tickTimeRef.current);
        }
        saveSnapshot(file.path);
        setLoading(false);
      },
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [file?.path, paused, pausedInput]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!file || olderBusyRef.current || startRef.current <= 0) return 0;
    olderBusyRef.current = true;
    setLoadingOlder(true);
    const gen = genRef.current;
    try {
      let text = "";
      let start = startRef.current;
      // A chunk may end mid-line; hop further back until the first newline shows up.
      for (let hop = 0; hop < OLDER_CHUNK_HOPS; hop += 1) {
        const res = await fetch(`/api/log?path=${encodeURIComponent(file.path)}&before=${start}`);
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
      updateHasMore(newStart > 0);
      if (complete.length) {
        const prev = winRef.current;
        updateWin({ lines: complete.concat(prev.lines), start: prev.start - complete.length });
        setPrependGen((value) => value + 1);
      }
      saveSnapshot(file.path);
      return complete.length;
    } catch {
      return 0;
    } finally {
      olderBusyRef.current = false;
      setLoadingOlder(false);
    }
  }, [file?.path]);

  return { lines: win.lines, linesStart: win.start, size, loading, error, tickTime, paused, setPaused, clear, hasMore, loadingOlder, loadOlder, prependGen };
}
