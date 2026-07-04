"use client";

/* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import { useCallback, useEffect, useRef, useState } from "react";

import type { FileEntry } from "@/lib/types";
import type { LogChunk } from "@/lib/types";

const POLL_MS = 1200;
/** Longest single jsonl line we are willing to chase across history chunks. */
const OLDER_CHUNK_HOPS = 4;

const utf8len = (text: string) => new TextEncoder().encode(text).length;

export interface LogTailState {
  lines: string[];
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
  const capRef = useRef(cap);
  const [lines, setLines] = useState<string[]>([]);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickTime, setTickTime] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [prependGen, setPrependGen] = useState(0);
  const offsetRef = useRef(0);
  const startRef = useRef(0);
  const tailRef = useRef("");
  const firstRef = useRef(true);
  const genRef = useRef(0);
  const pausedRef = useRef(false);
  const olderBusyRef = useRef(false);

  useEffect(() => {
    capRef.current = cap;
  }, [cap]);

  useEffect(() => {
    pausedRef.current = paused || pausedInput;
  }, [paused, pausedInput]);

  const resetWindow = () => {
    offsetRef.current = 0;
    startRef.current = 0;
    tailRef.current = "";
    firstRef.current = true;
    setHasMore(false);
  };

  const clear = useCallback(() => {
    setLines([]);
    resetWindow();
  }, []);

  useEffect(() => {
    genRef.current += 1;
    resetWindow();
    setLines([]);
    setSize(file?.size ?? 0);
    setError(null);
    setLoading(Boolean(file));
  }, [file?.path]);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    const gen = genRef.current;
    const poll = async () => {
      if (!alive || pausedRef.current) return;
      try {
        const res = await fetch(`/api/log?path=${encodeURIComponent(file.path)}&offset=${offsetRef.current}`);
        const json = (await res.json()) as LogChunk | { error?: string };
        if (!alive || gen !== genRef.current) return;
        if ("error" in json && json.error) {
          setError(json.error);
          setLoading(false);
          return;
        }
        const chunk = json as LogChunk;
        if (offsetRef.current > chunk.size) {
          resetWindow();
          setLines([]);
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
            setHasMore(startRef.current > 0);
          }
          const parts = data.split("\n");
          tailRef.current = parts.pop() ?? "";
          const complete = parts.map((line) => line.trim()).filter(Boolean);
          if (offsetRef.current === 0) setLines(complete);
          else if (complete.length)
            setLines((prev) => (capRef.current > 0 ? prev.concat(complete).slice(-capRef.current) : prev.concat(complete)));
          firstRef.current = false;
        }
        offsetRef.current = chunk.offset;
        setSize(chunk.size);
        setError(null);
        /* Idle polls must not re-render every pane every 1.2s: the tick time
           moves only when bytes actually arrived (status reads "last data"). */
        if (chunk.data) setTickTime(new Date());
        setLoading(false);
      } catch {
        if (alive && gen === genRef.current) {
          setError("сервер недоступний");
          setLoading(false);
        }
      }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [file?.path]);

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
      setHasMore(newStart > 0);
      if (complete.length) {
        setLines((prev) => complete.concat(prev));
        setPrependGen((value) => value + 1);
      }
      return complete.length;
    } catch {
      return 0;
    } finally {
      olderBusyRef.current = false;
      setLoadingOlder(false);
    }
  }, [file?.path]);

  return { lines, size, loading, error, tickTime, paused, setPaused, clear, hasMore, loadingOlder, loadOlder, prependGen };
}
