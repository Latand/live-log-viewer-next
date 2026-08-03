"use client";

import { ChevronDown, ChevronUp, WrapText } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { useHighlighted } from "../feed/highlight";
import {
  artifactContentUrl,
  failureFromStatus,
  formatBytes,
  type ArtifactFailure,
  type ArtifactMeta,
} from "./artifactResource";
import { splitHighlightedLines } from "./highlightLines";

/** One bounded read; a preview never pulls the whole of a large file at once. */
const TEXT_CHUNK = 256 * 1024;

/** Case-insensitive occurrences of `query` inside `line`. */
function matchesIn(line: string, query: string): number[] {
  const hits: number[] = [];
  const haystack = line.toLowerCase();
  const needle = query.toLowerCase();
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    hits.push(at);
    at = haystack.indexOf(needle, at + Math.max(needle.length, 1));
  }
  return hits;
}

function MarkedLine({ line, query }: { line: string; query: string }) {
  const hits = matchesIn(line, query);
  if (!hits.length) return <>{line}</>;
  const parts: React.ReactNode[] = [];
  let from = 0;
  hits.forEach((hit, i) => {
    parts.push(<Fragment key={`t${i}`}>{line.slice(from, hit)}</Fragment>);
    parts.push(
      <mark key={`m${i}`} className="rounded-[3px] bg-warning/40 text-primary">
        {line.slice(hit, hit + query.length)}
      </mark>,
    );
    from = hit + query.length;
  });
  parts.push(<Fragment key="tail">{line.slice(from)}</Fragment>);
  return <>{parts}</>;
}

/**
 * Bounded text preview: byte-ranged loads pinned to the meta validator, line
 * numbers, wrap toggle, search within the loaded portion, and hljs rendering
 * where the language is known and the loaded portion is small enough.
 */
export function TextPane({
  path,
  meta,
  onFailure,
}: {
  path: string;
  meta: ArtifactMeta;
  onFailure: (failure: ArtifactFailure) => void;
}) {
  const { t } = useLocale();
  const [chunks, setChunks] = useState<Uint8Array[]>([]);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [loading, setLoading] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const complete = loadedBytes >= meta.size;

  const loadMore = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const end = Math.min(loadedBytes + TEXT_CHUNK, meta.size) - 1;
      const response = await fetch(artifactContentUrl(path), {
        signal: controller.signal,
        headers: { range: `bytes=${loadedBytes}-${end}`, "if-match": meta.etag },
      });
      if (!response.ok) {
        onFailure(failureFromStatus(response.status));
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      setChunks((previous) => [...previous, bytes]);
      setLoadedBytes((previous) => previous + bytes.byteLength);
    } catch {
      if (!controller.signal.aborted) onFailure("error");
    } finally {
      setLoading(false);
    }
  }, [loading, loadedBytes, meta, path, onFailure]);

  /* First bounded chunk on mount; closing the preview aborts the in-flight
     read, which the route answers by closing its file descriptor. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the ranged
       fetch is the external system this pane synchronizes with; the sync
       setLoading(true) is its re-entrancy latch. */
    if (meta.size > 0) void loadMore();
    return () => abortRef.current?.abort();
    // Mount-only: later loads are explicit "load more" gestures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = useMemo(() => {
    if (!chunks.length) return "";
    const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  }, [chunks]);

  const lines = useMemo(() => text.split("\n"), [text]);
  const langHint = useMemo(() => meta.name.split(".").pop() ?? null, [meta.name]);
  const highlighted = useHighlighted(text, query ? null : langHint);
  const highlightedLines = useMemo(
    () => (highlighted ? splitHighlightedLines(highlighted) : null),
    [highlighted],
  );

  const matchLines = useMemo(() => {
    if (!query) return [];
    const hits: number[] = [];
    lines.forEach((line, index) => {
      if (matchesIn(line, query).length) hits.push(index);
    });
    return hits;
  }, [lines, query]);
  const totalMatches = useMemo(
    () => (query ? lines.reduce((total, line) => total + matchesIn(line, query).length, 0) : 0),
    [lines, query],
  );

  const jump = useCallback(
    (direction: 1 | -1) => {
      if (!matchLines.length) return;
      setCursor((previous) => (previous + direction + matchLines.length) % matchLines.length);
    },
    [matchLines.length],
  );

  useEffect(() => {
    if (!query || !matchLines.length) return;
    const line = matchLines[Math.min(cursor, matchLines.length - 1)];
    scrollRef.current
      ?.querySelector(`[data-preview-line="${line}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [query, cursor, matchLines]);

  const gutterWidth = `${Math.max(String(lines.length).length, 3)}ch`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <input
          type="search"
          value={query}
          onInput={(event) => {
            setQuery((event.target as HTMLInputElement).value);
            setCursor(0);
          }}
          placeholder={t("preview.searchPlaceholder")}
          aria-label={t("preview.searchPlaceholder")}
          className="h-7 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 text-[12px] text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        {query ? (
          <span className="text-[11.5px] tabular-nums text-muted" data-preview-matches>
            {totalMatches ? `${Math.min(cursor + 1, matchLines.length)}/${totalMatches}` : t("preview.noMatches")}
          </span>
        ) : null}
        {query ? (
          <>
            <button
              type="button"
              aria-label={t("preview.prevMatch")}
              title={t("preview.prevMatch")}
              onClick={() => jump(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t("preview.nextMatch")}
              title={t("preview.nextMatch")}
              onClick={() => jump(1)}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        ) : null}
        <button
          type="button"
          aria-pressed={wrap}
          aria-label={t("preview.wrapLines")}
          title={t("preview.wrapLines")}
          onClick={() => setWrap((value) => !value)}
          className={`flex h-7 w-7 items-center justify-center rounded-[8px] border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            wrap ? "bg-accent/15 text-accent" : "bg-canvas text-muted hover:text-primary"
          }`}
        >
          <WrapText className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-canvas font-mono text-[11.5px] leading-[1.5]">
        <div className={wrap ? "" : "w-max min-w-full"}>
          {lines.map((line, index) => (
            <div key={index} data-preview-line={index} className="flex">
              <span
                data-line-number
                aria-hidden
                className="sticky left-0 shrink-0 select-none border-r border-border bg-sunken px-1.5 text-right text-muted"
                style={{ width: gutterWidth, minWidth: gutterWidth }}
              >
                {index + 1}
              </span>
              {query ? (
                <span className={`px-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
                  <MarkedLine line={line} query={query} />
                </span>
              ) : highlightedLines && highlightedLines[index] !== undefined ? (
                <span
                  className={`hljs bg-transparent px-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
                  dangerouslySetInnerHTML={{ __html: highlightedLines[index] }}
                />
              ) : (
                <span className={`px-2 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>{line}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-[11.5px] text-muted">
        <span>{t("preview.loadedOf", { loaded: formatBytes(loadedBytes), size: formatBytes(meta.size) })}</span>
        {!complete ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadMore()}
            className="ml-auto rounded-[8px] border border-border bg-card px-2.5 py-1 font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
          >
            {loading ? t("preview.loading") : t("preview.loadMore")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
