"use client";

import { Fragment, memo, useEffect, useRef, useState } from "react";
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

/* The opening fence's info string (```ts, ```python, …) is the language hint
   highlight.js resolves; fence-only names like `python`/`shell` have no
   file-extension equivalent, so this is their only entry point. */
function fenceLang(line: string): string | null {
  return line.match(/^\s*```+\s*([A-Za-z0-9+#_-]+)/)?.[1] ?? null;
}

/* Block-level pass over `lines[from, to)`, appended to `out`. `lines` may be a
   TAIL of the document starting at absolute line `base`: every node is keyed by
   its absolute index and the trailing-newline bookkeeping reads `out` rather
   than local state, so a document can be rendered in several append-only slices
   and still come out identical to a single pass. That is what lets the
   streaming renderer below parse only what has just arrived. */
function pushBlocks(out: ReactNode[], lines: string[], from: number, to: number, base = 0): void {
  let i = from;
  while (i < to) {
    if (FENCE_OPEN_RE.test(lines[i])) {
      const start = i;
      const lang = fenceLang(lines[i]);
      i++;
      while (i < to && !FENCE_CLOSE_RE.test(lines[i])) i++;
      const code = lines.slice(start + 1, i).join("\n");
      if (i < to) i++;
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<CodeBlock key={`c${base + start}`} code={code} lang={lang} />);
      continue;
    }
    if (TABLE_ROW_RE.test(lines[i])) {
      const start = i;
      while (i < to && TABLE_ROW_RE.test(lines[i])) i++;
      /* The table div is a block element: the pending newline would add an empty row. */
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<MdTable key={`t${base + start}`} rows={lines.slice(start, i)} />);
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
      out.push(<MdImageRow key={`i${base + start}`} images={images} />);
      continue;
    }
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) {
      out.push(
        <span key={base + i} className="text-[14px] font-bold">
          {md(heading[1])}
        </span>,
      );
    } else if (quote) {
      out.push(
        <span key={base + i} className="border-l-2 border-border pl-2 text-muted">
          {md(quote[1])}
        </span>,
      );
    } else {
      out.push(<Fragment key={base + i}>{md(line)}</Fragment>);
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
   runs only where the answer can no longer change. Returns whether it opened
   with a block element, which the caller answers by dropping the newline the
   settled slice left pending — exactly what the settled pass will do when these
   lines eventually freeze. */
function pushPending(out: ReactNode[], lines: string[], from: number, base: number): boolean {
  const last = lines.length - 1;
  if (FENCE_OPEN_RE.test(lines[from] ?? "")) {
    /* A message may stop exactly ON its closing fence: that line has no newline
       yet, but the code between the fences is complete, and leaving the last
       block of an answer raw until the turn settles is the visible defect. The
       cost is the rare delta that continues the line and takes the block back. */
    if (last > from && FENCE_CLOSE_RE.test(lines[last])) {
      out.push(
        <CodeBlock key={`c${base + from}`} code={lines.slice(from + 1, last).join("\n")} lang={fenceLang(lines[from])} />,
      );
      return true;
    }
    /* An open fence stays verbatim. Its body is code, and a growing <pre> would
       re-run highlight.js on every delta. */
    for (let i = from; i <= last; i++) {
      out.push(<Fragment key={`p${base + i}`}>{lines[i]}</Fragment>);
      if (i < last) out.push("\n");
    }
    return false;
  }
  /* The closed lines of a trailing table or image run do render — that is how a
     message ENDING in a table looks like its settled self while it streams. A
     table waits for its second row: until that row lands the header/body split
     is still open, and deciding it early is exactly the kind of
     re-interpretation this avoids. Rows only ever append after. */
  const closed = lines.slice(from, last);
  const rows = closed.length >= 2 && closed.every((line) => TABLE_ROW_RE.test(line)) ? closed : null;
  const matches = rows ? [] : closed.map((line) => line.match(IMAGE_LINE_RE));
  const images = matches.length && matches.every((m) => m !== null)
    ? matches.map((m) => ({ alt: m![1], src: m![2] }))
    : null;
  let i = from;
  let block = false;
  if (rows || images) {
    /* Same key the settled pass will give this block, so it is reconciled in
       place — the table does not blink out and back when the run terminates. */
    out.push(rows
      ? <MdTable key={`t${base + from}`} rows={rows} />
      : <MdImageRow key={`i${base + from}`} images={images!} />);
    i = last;
    block = true;
  }
  for (; i <= last; i++) {
    out.push(<Fragment key={`p${base + i}`}>{md(lines[i])}</Fragment>);
    if (i < last) out.push("\n");
  }
  return block;
}

/* How much text before the cached boundary is compared to detect a rewrite. */
const ANCHOR = 128;

export interface MdStreamState {
  /** Chars already parsed into `blocks`, at a line start unless `lineStart`. */
  settledChars: number;
  /** Absolute index of the first unparsed line — the key base for the next slice. */
  settledLines: number;
  /** Whether `settledChars` sits at a line start (false only once a completed
      item has consumed its final, unterminated line). */
  lineStart: boolean;
  blocks: ReactNode[];
  /** Bumped whenever `blocks` changes: `blocks` is grown in place, so this is
      what tells the memoized prefix that it has to re-render. */
  revision: number;
  /** Whether the prefix's trailing newline was dropped for a pending block, and
      so has to come back if that block turns out not to be one after all. */
  droppedNewline: boolean;
  /** Text ending at `settledChars`, compared per delta instead of the prefix. */
  anchor: string;
  /** Inputs and output of the last advance, to make a repeated render free. */
  source: string;
  streaming: boolean;
  rendered: ReactNode;
  /** Chars scanned so far. A delta adds only the text from the last stable
      boundary — never the accumulated message. */
  scannedChars: number;
  /** Lines block-parsed so far: every line is parsed exactly once. */
  parsedLines: number;
}

export function createMdStream(): MdStreamState {
  return {
    settledChars: 0,
    settledLines: 0,
    lineStart: true,
    blocks: [],
    revision: 0,
    droppedNewline: false,
    anchor: "",
    source: "",
    streaming: false,
    rendered: null,
    scannedChars: 0,
    parsedLines: 0,
  };
}

/**
 * Whether what was parsed still describes the head of `text`.
 *
 * Deltas append; anything else — a completed item replacing its draft, the
 * bounded projection trimming its head — has to invalidate the cache. Comparing
 * the whole prefix would put the accumulated length back into every delta, so
 * while streaming the check is the anchor window ending at the boundary plus
 * monotone length. The completion call, which is the one that can legitimately
 * carry rewritten text, is checked exactly — it happens once per item.
 */
function reusable(state: MdStreamState, text: string, streaming: boolean): boolean {
  if (state.settledChars === 0) return true;
  if (text.length < state.settledChars) return false;
  if (!state.lineStart && text.length !== state.settledChars) return false;
  if (!streaming) return text.startsWith(state.source.slice(0, state.settledChars));
  return text.length >= state.source.length
    && text.slice(Math.max(0, state.settledChars - ANCHOR), state.settledChars) === state.anchor;
}

/* The parsed prefix, isolated behind memo: a delta that settles nothing leaves
   `revision` alone and React skips this subtree without walking it. */
const SettledPrefix = memo(function SettledPrefix({ nodes }: { nodes: ReactNode[]; revision: number }) {
  return nodes;
});

/**
 * Advances a streaming prose body to `text` and returns its tree.
 *
 * Work per call is proportional to what arrived, not to what has accumulated:
 * only the text after the last stable boundary is sliced, split and scanned, the
 * lines that just settled are parsed once and appended to the cached prefix, and
 * the volatile tail is re-rendered — normally one line, at most the open
 * construct. Re-parsing the accumulated text on every delta would be quadratic
 * over a long answer; this is linear over the whole stream.
 */
export function advanceMdStream(state: MdStreamState, text: string, streaming: boolean): ReactNode {
  if (state.rendered !== null && text === state.source && streaming === state.streaming) return state.rendered;
  if (!reusable(state, text, streaming)) {
    state.settledChars = 0;
    state.settledLines = 0;
    state.lineStart = true;
    state.blocks = [];
    state.droppedNewline = false;
    state.revision++;
  }
  const base = state.settledLines;
  const rest = text.slice(state.settledChars);
  const lines = rest.split("\n");
  const settled = streaming ? settledLineCount(lines) : lines.length;
  state.scannedChars += rest.length;
  if (settled > 0) {
    pushBlocks(state.blocks, lines, 0, settled, base);
    let chars = 0;
    for (let i = 0; i < settled; i++) chars += lines[i].length + 1;
    /* The last line of a completed item ends the text instead of a newline. */
    state.lineStart = state.settledChars + chars <= text.length;
    state.settledChars = Math.min(state.settledChars + chars, text.length);
    state.settledLines += settled;
    state.anchor = text.slice(Math.max(0, state.settledChars - ANCHOR), state.settledChars);
    state.parsedLines += settled;
    /* pushBlocks has re-established the separator itself. */
    state.droppedNewline = false;
    state.revision++;
  }
  let pending: ReactNode[] | null = null;
  if (settled < lines.length) {
    pending = [];
    const block = pushPending(pending, lines, settled, base);
    /* A pending block element sheds the separator the prefix left behind — and
       takes it back if the next delta turns it into ordinary text again, which
       is what an unfinished line reopening a fence does. */
    if (block && state.blocks[state.blocks.length - 1] === "\n") {
      state.blocks.pop();
      state.droppedNewline = true;
      state.revision++;
    } else if (!block && state.droppedNewline) {
      state.blocks.push("\n");
      state.droppedNewline = false;
      state.revision++;
    }
  }
  let tree: ReactNode = <SettledPrefix nodes={state.blocks} revision={state.revision} />;
  if (pending) tree = <>{tree}{pending}</>;
  state.source = text;
  state.streaming = streaming;
  state.rendered = tree;
  return tree;
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
