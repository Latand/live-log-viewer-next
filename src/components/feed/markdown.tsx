"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { CopyButton, copyText } from "./CopyButton";
import { useHighlighted } from "./highlight";
import { Lightbox } from "./Lightbox";
import { tr } from "./parse";

/* Image markdown wins over the link pattern, so `![alt](url)` embeds instead
   of leaking a literal «!» and a link. */
const MD_INLINE_RE = /(!\[[^\]]*\]\([^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>"')\]]+)/g;
const IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/* Inline monospace chip that copies itself on click. A span, not a button:
   it keeps text flow and selection intact, and inside a <summary> a button
   would fight the collapsible toggle. */
function InlineCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  return (
    <span
      title={copied ? tr("common.copied") : tr("common.clickToCopy")}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_400);
        });
      }}
      className={`cursor-copy rounded-md px-1.5 py-0.5 font-mono ${copied ? "bg-success/15 text-success" : "bg-sunken"}`}
    >
      {text}
    </span>
  );
}

/* Fenced block with a copy control that surfaces on hover (always faintly
   there on touch screens, where hover never comes). A `lang` hint lazily
   upgrades the body to highlight.js output on first paint (see useHighlighted);
   until the chunk resolves — or when the language is unknown — it stays plain
   monospace, so nothing blocks or flashes. */
export function CodeBlock({ code, lang }: { code: string; lang?: string | null }) {
  const highlighted = useHighlighted(code, lang);
  return (
    <div className="group/code relative my-1.5 max-w-full">
      {highlighted ? (
        <pre
          className="hljs max-w-full overflow-x-auto rounded-[10px] border border-border bg-canvas px-3 py-2 font-mono text-[11.5px]"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="max-w-full overflow-x-auto rounded-[10px] border border-border bg-canvas px-3 py-2 font-mono text-[11.5px]">{code}</pre>
      )}
      <CopyButton
        text={code}
        label={tr("feed.copyCode")}
        className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/code:opacity-100 [@media(hover:none)]:opacity-60"
      />
    </div>
  );
}

function linkHref(raw: string): string {
  const href = raw.replace(/\\([()])/g, "$1");
  const local = href.replace(/^file:\/\//, "");
  if (/^(?:\/|~\/)/.test(local)) {
    return `#f=${encodeURIComponent(local.replace(/:\d+$/, ""))}`;
  }
  return href;
}

function Anchor({ href, label }: { href: string; label: string }) {
  const external = /^https?:\/\//.test(href);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      title={href}
      className="break-all text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </a>
  );
}

/* Where an image's bytes come from: http(s)/data URIs load straight; a local
   path (or file:// URL, as agents emit) streams through /api/image. */
function imageSrc(raw: string): string {
  const url = raw.replace(/\\([()])/g, "$1");
  if (/^(?:https?:)?\/\//.test(url) || url.startsWith("data:")) return url;
  const local = url.replace(/^file:\/\//, "");
  return `/api/image?path=${encodeURIComponent(local)}`;
}

/* Inline embedded image: a capped thumbnail that opens the full-size lightbox
   on click, and quietly degrades to a plain link if the bytes never load. */
function MdImage({ alt, src }: { alt: string; src: string }) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const resolved = imageSrc(src);
  if (failed) return <Anchor href={linkHref(src)} label={alt || src} />;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary local/remote src, next/image cannot serve it */}
      <img
        src={resolved}
        alt={alt}
        title={alt || undefined}
        loading="lazy"
        onClick={() => setFull(true)}
        onError={() => setFailed(true)}
        className="my-1 max-h-[240px] max-w-full cursor-zoom-in rounded-[10px] border border-border align-top"
      />
      {full ? <Lightbox src={resolved} alt={alt} caption={alt || undefined} onClose={() => setFull(false)} /> : null}
    </>
  );
}

/* A run of image-only lines flows as a wrapping thumbnail row (a contact sheet
   of screenshots reads far better side by side than stacked). */
function MdImageRow({ images }: { images: { alt: string; src: string }[] }) {
  return (
    <div className="my-1.5 flex flex-wrap items-start gap-2">
      {images.map((image, i) => (
        <MdImage key={i} alt={image.alt} src={image.src} />
      ))}
    </div>
  );
}

export function md(text: string): ReactNode {
  const parts = text.split(MD_INLINE_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`")) {
      return <InlineCode key={i} text={part.slice(1, -1)} />;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) return <MdImage key={i} alt={image[1]} src={image[2]} />;
    const linked = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (linked) {
      return <Anchor key={i} href={linkHref(linked[2])} label={linked[1]} />;
    }
    if (/^https?:\/\//.test(part)) {
      /* Bare URLs in prose often carry sentence punctuation; keep it as text. */
      const href = part.replace(/[.,;:!?…»)]+$/, "");
      const tail = part.slice(href.length);
      const label = href.length > 72 ? href.slice(0, 69) + "…" : href;
      return (
        <span key={i}>
          <Anchor href={href} label={label} />
          {tail}
        </span>
      );
    }
    return part;
  });
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_CELL_RE = /^:?-{1,}:?$/;

function MdTable({ rows }: { rows: string[] }) {
  const parsed = rows.map((row) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim()),
  );
  const hasHeader = parsed.length > 1 && parsed[1].every((cell) => TABLE_SEP_CELL_RE.test(cell));
  const head = hasHeader ? parsed[0] : null;
  const body = hasHeader ? parsed.slice(2) : parsed;
  return (
    <div className="my-1.5 max-w-full overflow-x-auto">
      <table className="border-collapse text-[12.5px]">
        {head ? (
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i} className="border border-border bg-sunken px-2.5 py-1 text-left font-semibold">
                  {md(cell)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="border border-border px-2.5 py-1 align-top">
                  {md(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FENCE_OPEN_RE = /^\s*```/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

/* Block-level pass over `lines[from, to)`, appended to `out`. Every node is
   keyed by its ABSOLUTE line index, and the trailing-newline bookkeeping reads
   `out` rather than local state, so one document can be rendered in several
   append-only slices and still come out identical to a single pass — that is
   what lets the streaming renderer below freeze what it has already parsed. */
function pushBlocks(out: ReactNode[], lines: string[], from: number, to: number): void {
  let i = from;
  while (i < to) {
    if (FENCE_OPEN_RE.test(lines[i])) {
      const start = i;
      /* The opening fence's info string (```ts, ```python, …) is the language
         hint highlight.js resolves; fence-only names like `python`/`shell` have
         no file-extension equivalent, so this is their only entry point. */
      const lang = lines[i].match(/^\s*```+\s*([A-Za-z0-9+#_-]+)/)?.[1] ?? null;
      i++;
      while (i < to && !FENCE_CLOSE_RE.test(lines[i])) i++;
      const code = lines.slice(start + 1, i).join("\n");
      if (i < to) i++;
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<CodeBlock key={`c${start}`} code={code} lang={lang} />);
      continue;
    }
    if (TABLE_ROW_RE.test(lines[i])) {
      const start = i;
      while (i < to && TABLE_ROW_RE.test(lines[i])) i++;
      /* The table div is a block element: the pending newline would add an empty row. */
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<MdTable key={`t${start}`} rows={lines.slice(start, i)} />);
      continue;
    }
    if (IMAGE_LINE_RE.test(lines[i])) {
      const start = i;
      const images: { alt: string; src: string }[] = [];
      while (i < to) {
        const m = lines[i].match(IMAGE_LINE_RE);
        if (!m) break;
        images.push({ alt: m[1], src: m[2] });
        i++;
      }
      /* The row is a block element: drop the pending newline before it. */
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<MdImageRow key={`i${start}`} images={images} />);
      continue;
    }
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) {
      out.push(
        <span key={i} className="text-[14px] font-bold">
          {md(heading[1])}
        </span>,
      );
    } else if (quote) {
      out.push(
        <span key={i} className="border-l-2 border-border pl-2 text-muted">
          {md(quote[1])}
        </span>,
      );
    } else {
      out.push(<Fragment key={i}>{md(line)}</Fragment>);
    }
    i++;
    /* The newline belongs to the document, not to the slice: a slice that stops
       short of the end is followed by more lines, so it keeps its separator. */
    if (i < lines.length) out.push("\n");
  }
}

/* Block-level pass for whole prose messages rendered inside whitespace-pre-wrap:
   newlines survive as text; tables group into real <table>, headings and
   blockquotes are styled per line, everything else goes through the inline pass. */
export function mdBlocks(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  pushBlocks(out, lines, 0, lines.length);
  return out;
}

/* How far the block extending from `lines[i]` reaches, and whether a line
   arriving after `limit` could still be swallowed by it. */
function blockSpan(lines: string[], i: number, limit: number): { end: number; extendable: boolean } {
  if (FENCE_OPEN_RE.test(lines[i])) {
    let j = i + 1;
    while (j < limit && !FENCE_CLOSE_RE.test(lines[j])) j++;
    /* A closed fence is finished; an open one keeps eating whatever comes. */
    return j < limit ? { end: j + 1, extendable: false } : { end: limit, extendable: true };
  }
  const run = TABLE_ROW_RE.test(lines[i]) ? TABLE_ROW_RE : IMAGE_LINE_RE.test(lines[i]) ? IMAGE_LINE_RE : null;
  if (run) {
    let j = i;
    while (j < limit && run.test(lines[j])) j++;
    return { end: j, extendable: true };
  }
  return { end: i + 1, extendable: false };
}

/**
 * How many leading lines of a still-arriving message can no longer change
 * meaning. The last line has no terminating newline yet, so it is always
 * volatile; and a construct that runs up against it — an unclosed fence, a
 * table or image run that the next line may join — is volatile with it.
 * Everything before that point is final: later deltas cannot reinterpret it.
 */
export function settledLineCount(lines: string[]): number {
  const complete = lines.length - 1;
  let i = 0;
  while (i < complete) {
    const span = blockSpan(lines, i, complete);
    if (span.extendable && span.end >= complete) return i;
    i = span.end;
  }
  return Math.max(complete, 0);
}

/* Lines the agent is still writing, rendered so that nothing ever re-interprets
   itself on a later delta — the message must not twitch as it is typed. The
   inline pass alone already degrades to plain text for any construct whose
   closer has not arrived (`**bol`, a half-written row), and the block grammar
   runs only where the answer can no longer change: */
function pushPending(out: ReactNode[], lines: string[], from: number): void {
  /* …never inside an open fence. Its body is code, must stay verbatim, and a
     growing <pre> would re-run highlight.js on every delta. */
  if (FENCE_OPEN_RE.test(lines[from] ?? "")) {
    for (let i = from; i < lines.length; i++) {
      out.push(<Fragment key={`p${i}`}>{lines[i]}</Fragment>);
      if (i < lines.length - 1) out.push("\n");
    }
    return;
  }
  /* …but yes for the closed lines of a trailing table or image run, which is
     how a message that ENDS with a table gets to look like its settled self
     while it streams. A table waits for its second row: until that row lands,
     the header/body split is still open, and deciding it early is exactly the
     kind of re-interpretation this is avoiding. Rows only ever append after. */
  const complete = lines.length - 1;
  const closed = lines.slice(from, complete);
  const rows = closed.length >= 2 && closed.every((line) => TABLE_ROW_RE.test(line)) ? closed : null;
  const matches = rows ? [] : closed.map((line) => line.match(IMAGE_LINE_RE));
  const images = matches.length && matches.every((m) => m !== null)
    ? matches.map((m) => ({ alt: m![1], src: m![2] }))
    : null;
  let i = from;
  if (rows || images) {
    /* Block element: drop the newline the settled slice left pending. */
    if (out[out.length - 1] === "\n") out.pop();
    /* Same key the settled pass will give this block, so it is reconciled in
       place — the table does not blink out and back when the run terminates. */
    out.push(rows
      ? <MdTable key={`t${from}`} rows={rows} />
      : <MdImageRow key={`i${from}`} images={images!} />);
    i = complete;
  }
  for (; i < lines.length; i++) {
    out.push(<Fragment key={`p${i}`}>{md(lines[i])}</Fragment>);
    if (i < lines.length - 1) out.push("\n");
  }
}

export interface MdStreamState {
  source: string;
  settled: number;
  blocks: ReactNode[];
  /** Lines block-parsed so far. A delta must not grow this by more than the
      lines it just settled — that is the whole point of the cache. */
  parsedLines: number;
}

export function createMdStream(): MdStreamState {
  return { source: "", settled: 0, blocks: [], parsedLines: 0 };
}

/**
 * Advances a streaming prose body to `text` and returns its nodes.
 *
 * The settled prefix is parsed ONCE and kept in `state`: a call parses only the
 * lines that just became final, and re-renders the volatile tail — normally one
 * line, at most the open construct. The cached nodes keep their element
 * identity, so React skips those subtrees and highlight.js never re-runs for a
 * fence that is already closed. Re-parsing the accumulated text on every delta
 * would be quadratic over a long answer; this is linear over the whole stream.
 */
export function advanceMdStream(state: MdStreamState, text: string, streaming: boolean): ReactNode[] {
  const lines = text.split("\n");
  const settled = streaming ? settledLineCount(lines) : lines.length;
  /* Deltas append; anything else (a completed item replacing its draft, a
     bounded projection trimming its head) invalidates what was parsed. */
  if (!text.startsWith(state.source) || settled < state.settled) {
    state.blocks = [];
    state.settled = 0;
  }
  if (settled > state.settled) {
    pushBlocks(state.blocks, lines, state.settled, settled);
    state.parsedLines += settled - state.settled;
    state.settled = settled;
  }
  state.source = text;
  const out = state.blocks.slice();
  if (settled < lines.length) pushPending(out, lines, settled);
  return out;
}

/**
 * A prose body that may still be streaming, rendered by the same grammar as a
 * settled transcript message — so nothing changes appearance when the echo of a
 * live turn lands.
 */
export function StreamingMd({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  /* A memo of the props, held in state because it is grown across renders and
     must survive every one of them. Advancing it is idempotent, so a repeated
     render of the same text yields the same tree. */
  const [stream] = useState(createMdStream);
  return advanceMdStream(stream, text, streaming);
}
