"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { artifactContentUrl } from "@/components/preview/artifactResource";
import { openArtifactPreview } from "@/components/preview/previewBus";
import { classifyArtifact } from "@/lib/artifact/classify";

import { CopyButton, copyText } from "./CopyButton";
import { useHighlighted } from "./highlight";
import { Lightbox } from "./Lightbox";
import { ACTION_ANCHOR, ACTION_GUTTER, MESSAGE_ACTION } from "./actionStyles";
import { tr } from "./parse";

/* A link/image target: one unbroken run, in which a backslash escapes the
   character after it — the spelling agents use for parens inside a URL
   (`…/Home_\(draft\)`), which a bare `[^)\s]+` would cut at the first `)`.
   The two branches are disjoint (the second excludes the backslash), so a
   target that never closes fails linearly instead of backtracking. */
const MD_URL = String.raw`(?:\\.|[^)\s\\])+`;
const MD_IMAGE = String.raw`!\[[^\]]*\]\(${MD_URL}\)`;
const MD_LINK = String.raw`\[[^\]]+\]\(${MD_URL}\)`;

/* Image markdown wins over the link pattern, so `![alt](url)` embeds instead
   of leaking a literal «!» and a link. Bold comes before the link only so a
   `**…**` run keeps its emphasis: its body goes back through this same pass
   (see `md`), so a link inside bold is still a link. */
const MD_INLINE_RE = new RegExp(
  `(${MD_IMAGE}|\`[^\`]+\`|\\*\\*[^*]+\\*\\*|${MD_LINK}|https?://[^\\s<>"')\\]]+)`,
  "g",
);
const IMAGE_LINE_RE = new RegExp(String.raw`^\s*!\[([^\]]*)\]\((${MD_URL})\)\s*$`);
const IMAGE_PART_RE = new RegExp(String.raw`^!\[([^\]]*)\]\((${MD_URL})\)$`);
const LINK_PART_RE = new RegExp(String.raw`^\[([^\]]+)\]\((${MD_URL})\)$`);

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

/* Fenced block with a copy control parked in its own right gutter — legible at
   rest on every pointer, and never on top of the first line. A `lang` hint
   lazily upgrades the body to highlight.js output on first paint (see
   useHighlighted); until the chunk resolves — or when the language is unknown —
   it stays plain monospace, so nothing blocks or flashes.

   The block owns its copy control, so an embedder renders none of its own —
   `copyLabel` lets it name what the block actually holds (an expanded tool
   output says "copy output", not "copy code"). */
export function CodeBlock({ code, lang, copyLabel }: { code: string; lang?: string | null; copyLabel?: string }) {
  const highlighted = useHighlighted(code, lang);
  return (
    <div className="group/code relative my-1.5 max-w-full">
      {highlighted ? (
        <pre
          className={`hljs max-w-full overflow-x-auto rounded-[10px] border border-border bg-canvas py-2 pl-3 font-mono text-[11.5px] ${ACTION_GUTTER}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className={`max-w-full overflow-x-auto rounded-[10px] border border-border bg-canvas py-2 pl-3 font-mono text-[11.5px] ${ACTION_GUTTER}`}>{code}</pre>
      )}
      {/* Issue #698: the control keeps its own gutter (`ACTION_GUTTER`, sized
          for the 44px coarse-pointer button) instead of floating over the first
          lines of code, and it is legible without a hover. */}
      <CopyButton
        text={code}
        label={copyLabel ?? tr("feed.copyCode")}
        className={`${ACTION_ANCHOR} ${MESSAGE_ACTION} group-hover/code:opacity-100`}
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

const ANCHOR_CLASS = "break-all text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent";

/** The local spelling of a link, or null when it is not a local path. */
function localPath(href: string): string | null {
  const local = href.replace(/^file:\/\//, "");
  return /^(?:\/|~\/)/.test(local) ? local : null;
}

function Anchor({ href: raw, label }: { href: string; label: string }) {
  const href = raw.replace(/\\([()])/g, "$1");
  const local = localPath(href);
  /* A linked local artifact (issue #875) opens the in-app preview surface —
     same-document, no navigation, no history entry. The href still names the
     resource route so copy/middle-click keep working; everything else keeps
     the legacy behavior (`#f=` conversation deep link, ordinary web anchor). */
  const artifact = local !== null && classifyArtifact(local) !== null;
  if (artifact) {
    return (
      <a
        href={artifactContentUrl(local!)}
        title={href}
        className={ANCHOR_CLASS}
        onClick={(event) => {
          event.preventDefault();
          openArtifactPreview(local!);
        }}
      >
        {label}
      </a>
    );
  }
  const resolved = local !== null ? linkHref(raw) : href;
  const external = /^https?:\/\//.test(resolved);
  return (
    <a
      href={resolved}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      title={href}
      className={ANCHOR_CLASS}
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
  if (failed) return <Anchor href={src} label={alt || src} />;
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
    /* A bold run is emphasis around markdown, not a leaf: its body goes back
       through the pass, so `**[#12](https://…)**` — how an agent writes a
       release note — renders as a bold LINK instead of literal brackets. The
       body cannot contain another `**` (the alternative is `[^*]+`), so this
       recurses exactly once. */
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{md(part.slice(2, -2))}</b>;
    const image = part.match(IMAGE_PART_RE);
    if (image) return <MdImage key={i} alt={image[1]} src={image[2]} />;
    const linked = part.match(LINK_PART_RE);
    if (linked) {
      return <Anchor key={i} href={linked[2]} label={linked[1]} />;
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

/* One line that is not part of a multi-line block: a styled heading or
   blockquote, otherwise the inline pass. */
function lineNode(line: string, key: number | string): ReactNode {
  const heading = line.match(/^#{1,6}\s+(.*)$/);
  if (heading) {
    return (
      <span key={key} className="text-[14px] font-bold">
        {md(heading[1])}
      </span>
    );
  }
  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return (
      <span key={key} className="border-l-2 border-border pl-2 text-muted">
        {md(quote[1])}
      </span>
    );
  }
  return <Fragment key={key}>{md(line)}</Fragment>;
}

/* Block-level pass for whole prose messages rendered inside whitespace-pre-wrap:
   newlines survive as text; tables group into real <table>, headings and
   blockquotes are styled per line, everything else goes through the inline pass.
   This is the settled rendering — the one a transcript row shows and the one
   the streaming machine below has to arrive at exactly. */
export function mdBlocks(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (FENCE_OPEN_RE.test(lines[i])) {
      const start = i;
      const lang = fenceLang(lines[i]);
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) i++;
      const code = lines.slice(start + 1, i).join("\n");
      if (i < lines.length) i++;
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<CodeBlock key={`c${start}`} code={code} lang={lang} />);
      continue;
    }
    if (TABLE_ROW_RE.test(lines[i])) {
      const start = i;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) i++;
      /* The table div is a block element: the pending newline would add an empty row. */
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<MdTable key={`t${start}`} rows={lines.slice(start, i)} />);
      continue;
    }
    if (IMAGE_LINE_RE.test(lines[i])) {
      const start = i;
      const images: { alt: string; src: string }[] = [];
      while (i < lines.length) {
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
    out.push(lineNode(lines[i], i));
    i++;
    if (i < lines.length) out.push("\n");
  }
  return out;
}


/* ---------------------------------------------------------------------------
   Streaming.

   A live turn row re-renders on every delta, so the renderer above cannot just
   be re-run: the message would be re-parsed hundreds of times. The machine
   below consumes a message the way it arrives — one complete line at a time —
   and appends the nodes it produces to a list it never re-walks. A delta only
   ever touches the line still being written and the construct that line is
   inside, so its cost is the delta's, not the accumulated message's.
--------------------------------------------------------------------------- */

/** Nodes per chunk: the ceiling on what one settled line can make React redo. */
const CHUNK = 48;
/** Text kept before the boundary, to PROPOSE where a head-trim moved it to.
    Never evidence on its own — every proposal is verified against the text. */
const ANCHOR = 128;

/* A run of already-rendered nodes. A chunk's element is re-created only when
   its own nodes change, so React skips every untouched chunk on element
   identity alone — it never walks what the message has already shown. */
function MdChunk({ nodes }: { nodes: ReactNode[] }): ReactNode {
  return nodes;
}

interface MdChunk {
  key: number;
  /** Char offset of the chunk's first line, and the separator owed at it —
      a chunk always begins at a line where no construct is open, so this is
      all the context needed to re-parse from here. */
  from: number;
  sep: boolean;
  /** Lines consumed into this chunk, so a trim can recount what survived. */
  lines: number;
  nodes: ReactNode[];
  element: ReactNode;
}

interface MdRegion {
  chunks: MdChunk[];
  keys: number;
}

function newRegion(): MdRegion {
  return { chunks: [], keys: 0 };
}

/** The chunk to append to, cutting a new one when the current is full. Only
    ever called where no construct is open, so a chunk boundary is always a
    point the message can be re-parsed from. */
function chunkFor(region: MdRegion, from: number, sep: boolean): MdChunk {
  const last = region.chunks[region.chunks.length - 1];
  if (last && last.nodes.length < CHUNK) return last;
  const chunk: MdChunk = { key: region.keys++, from, sep, lines: 0, nodes: [], element: null };
  region.chunks.push(chunk);
  return chunk;
}

/** Re-creates the live chunk's element; every frozen chunk keeps its own. */
function seal(region: MdRegion): void {
  const chunk = region.chunks[region.chunks.length - 1];
  chunk.element = <MdChunk key={chunk.key} nodes={chunk.nodes} />;
}

function regionNodes(region: MdRegion): ReactNode[] {
  return region.chunks.map((chunk) => chunk.element);
}

/* The construct currently swallowing lines. It owns exactly one node slot in
   the live chunk, so it can change shape — a row count deciding a table, a
   fence closing — by re-emitting that slot, never by moving anything. */
type MdRun =
  | { kind: "fence"; slot: number; sep: boolean; key: number; lang: string | null; code: string[]; joined: string | null; body: MdRegion; shown: number }
  | { kind: "table"; slot: number; sep: boolean; key: number; rows: string[] }
  | { kind: "images"; slot: number; sep: boolean; key: number; images: { alt: string; src: string }[] };

export interface MdStreamState {
  /** Chars consumed into nodes: the start of the line still being written.
      Everything a delta does begins here. */
  stableChars: number;
  /** Lines consumed into nodes. */
  stableLines: number;
  /** False once a completed message has consumed its final, unterminated line. */
  lineStart: boolean;
  region: MdRegion;
  run: MdRun | null;
  /** A newline owed to the next node, dropped if that node is a block —
      which is how the separator bookkeeping stays local to one append. */
  sep: boolean;
  /** Whether the volatile line is currently being shown as a closing fence. */
  provisional: boolean;
  anchor: string;
  source: string;
  streaming: boolean;
  rendered: ReactNode;
  keys: number;
}

export function createMdStream(): MdStreamState {
  return {
    stableChars: 0,
    stableLines: 0,
    lineStart: true,
    region: newRegion(),
    run: null,
    sep: false,
    provisional: false,
    anchor: "",
    source: "",
    streaming: false,
    rendered: null,
    keys: 0,
  };
}

function resetMdStream(state: MdStreamState): void {
  state.stableChars = 0;
  state.stableLines = 0;
  state.lineStart = true;
  state.region = newRegion();
  state.run = null;
  state.sep = false;
  state.provisional = false;
  state.anchor = "";
}

/** What an open run looks like right now, and whether that is a block element. */
function runNode(run: MdRun, closing: boolean): { node: ReactNode; block: boolean } {
  if (run.kind === "images") return { node: <MdImageRow key={`i${run.key}`} images={run.images} />, block: true };
  if (run.kind === "table") {
    /* One row cannot say whether it is a header: rendering it as a table now
       would move it into the header when the separator row lands. */
    if (!closing && run.rows.length < 2) return { node: lineNode(run.rows[0], `p${run.key}`), block: false };
    return { node: <MdTable key={`t${run.key}`} rows={run.rows} />, block: true };
  }
  if (closing) {
    run.joined ??= run.code.join("\n");
    return { node: <CodeBlock key={`c${run.key}`} code={run.joined} lang={run.lang} />, block: true };
  }
  /* An open fence stays verbatim: its body is code, and a growing <pre> would
     re-run highlight.js on every delta. The lines already written accumulate
     in their own region, so a new one costs one node, not a re-render. */
  return { node: <MdChunk key={`f${run.key}`} nodes={regionNodes(run.body)} />, block: false };
}

/* Re-emits the open run's slot in place. Truncating back to the slot is what
   lets a run change shape without leaving anything behind — and because the
   slot never moves, a block that is already on screen is never remounted. */
function paintRun(state: MdStreamState, closing: boolean): void {
  const run = state.run!;
  const chunk = state.region.chunks[state.region.chunks.length - 1];
  chunk.nodes.length = run.slot;
  const { node, block } = runNode(run, closing);
  if (!block && run.sep) chunk.nodes.push("\n");
  chunk.nodes.push(node);
  state.sep = !block;
  seal(state.region);
}

function closeRun(state: MdStreamState): void {
  paintRun(state, true);
  state.run = null;
  state.provisional = false;
}

/** One more verbatim line of an open fence, appended to its own region. */
function pushFenceLine(run: Extract<MdRun, { kind: "fence" }>, line: string, key: number): void {
  const chunk = chunkFor(run.body, 0, false);
  if (run.shown++ > 0) chunk.nodes.push("\n");
  chunk.nodes.push(<Fragment key={key}>{line}</Fragment>);
  seal(run.body);
}

/** Appends one finished line's node, honouring the owed separator. */
function emitNode(state: MdStreamState, node: ReactNode, block: boolean): void {
  const chunk = state.region.chunks[state.region.chunks.length - 1];
  if (!block && state.sep) chunk.nodes.push("\n");
  chunk.nodes.push(node);
  state.sep = !block;
  seal(state.region);
}

/* Consumes one COMPLETE line — a line whose newline has arrived, so neither its
   text nor (given the run it lands in) its meaning can change again. */
function consume(state: MdStreamState, line: string, from: number): void {
  const run = state.run;
  if (run) {
    /* A line the run swallows belongs to the chunk the run lives in. */
    const held = state.region.chunks[state.region.chunks.length - 1];
    if (run.kind === "fence") {
      held.lines++;
      if (FENCE_CLOSE_RE.test(line)) {
        closeRun(state);
        return;
      }
      run.code.push(line);
      run.joined = null;
      pushFenceLine(run, line, state.keys++);
      paintRun(state, false);
      return;
    }
    if (run.kind === "table" && TABLE_ROW_RE.test(line)) {
      held.lines++;
      run.rows.push(line);
      paintRun(state, false);
      return;
    }
    if (run.kind === "images") {
      const more = line.match(IMAGE_LINE_RE);
      if (more) {
        held.lines++;
        run.images.push({ alt: more[1], src: more[2] });
        paintRun(state, false);
        return;
      }
    }
    /* The run ends here; this line is whatever it is on its own. */
    closeRun(state);
  }
  /* No run is open, so this is a point the message can be re-parsed from: the
     only place a chunk may be cut. */
  const chunk = chunkFor(state.region, from, state.sep);
  chunk.lines++;
  if (FENCE_OPEN_RE.test(line)) {
    state.run = {
      kind: "fence",
      slot: chunk.nodes.length,
      sep: state.sep,
      key: state.keys++,
      lang: fenceLang(line),
      code: [],
      joined: null,
      body: newRegion(),
      shown: 0,
    };
    pushFenceLine(state.run, line, state.keys++);
    paintRun(state, false);
    return;
  }
  if (TABLE_ROW_RE.test(line)) {
    state.run = { kind: "table", slot: chunk.nodes.length, sep: state.sep, key: state.keys++, rows: [line] };
    paintRun(state, false);
    return;
  }
  const image = line.match(IMAGE_LINE_RE);
  if (image) {
    state.run = {
      kind: "images",
      slot: chunk.nodes.length,
      sep: state.sep,
      key: state.keys++,
      images: [{ alt: image[1], src: image[2] }],
    };
    paintRun(state, false);
    return;
  }
  emitNode(state, lineNode(line, state.keys++), false);
}

/**
 * Whether what has been rendered still describes the head of `text`.
 *
 * This is checked EXACTLY, against the whole text the nodes were built from.
 * A fixed window is not evidence: 128 chars of repeated log lines, boilerplate
 * or a spinner alias trivially, and a message that matched at a stale offset
 * would keep rendering lines it no longer contains — a divergence that grows
 * and never heals. One native comparison per delta is the price, and it is the
 * comparison, not a re-parse: what a reused frame costs stays flat.
 */
function reusable(state: MdStreamState, text: string): boolean {
  if (state.stableChars === 0) return true;
  if (!state.lineStart || text.length < state.source.length) return false;
  /* The boundary is a line start by construction; if it is not, the state is
     not describing this text and nothing may be reused from it. */
  if (text.charCodeAt(state.stableChars - 1) !== 10) return false;
  return text.startsWith(state.source);
}

/**
 * Recovers the shift when the live projection trims a message's head, which it
 * does on EVERY delta once a turn passes its 64 KiB bound — exactly the long
 * answers where re-parsing the whole window per delta hurts most.
 *
 * Chunks the trim reached are dropped and the lines in front of the first
 * survivor are parsed again; everything behind it is context-free (a chunk
 * begins where no construct is open) and is kept as it is. If that head parse
 * ends inside a construct, the trim has changed how the rest reads, and nothing
 * is reused.
 *
 * The anchor only PROPOSES a shift — a window can alias, so the proposal is
 * then verified exactly against the text it claims to describe, and a shift
 * that does not hold up is no shift at all. Only a streaming delta is
 * recovered: the completion call is the one that can legitimately carry
 * rewritten text. A caller MUST reset the stream when this returns false — it
 * shifts the chunk offsets before it can know.
 */
function recoverTrim(state: MdStreamState, text: string, streaming: boolean): boolean {
  if (!streaming || !state.anchor || !state.lineStart) return false;
  const at = text.lastIndexOf(state.anchor);
  if (at < 0) return false;
  const stable = at + state.anchor.length;
  const shift = state.stableChars - stable;
  if (shift <= 0) return false;
  if (!text.startsWith(state.source.slice(shift))) return false;
  const chunks = state.region.chunks;
  for (const chunk of chunks) chunk.from -= shift;
  const keep = chunks.findIndex((chunk) => chunk.from >= 0);
  if (keep < 0) return false;
  const survivors = chunks.slice(keep);
  const head = createMdStream();
  const kept = survivors[0].from;
  const lines = text.slice(0, kept).split("\n");
  let from = 0;
  /* The head ends where the first survivor begins, so its last line is
     complete and split leaves a trailing empty entry to drop. */
  for (let i = 0; i < lines.length - 1; i++) {
    consume(head, lines[i], from);
    from += lines[i].length + 1;
  }
  if (head.run || head.sep !== survivors[0].sep) return false;
  for (const chunk of head.region.chunks) {
    chunk.key = state.region.keys++;
    chunk.element = <MdChunk key={chunk.key} nodes={chunk.nodes} />;
  }
  state.region.chunks = [...head.region.chunks, ...survivors];
  state.stableChars = stable;
  state.stableLines = state.region.chunks.reduce((total, chunk) => total + chunk.lines, 0);
  return true;
}

/**
 * Advances a streaming prose body to `text` and returns its tree.
 *
 * The cost of a call is the cost of what arrived: the text is sliced, split and
 * scanned only from the line still being written, each complete line is parsed
 * once into an append-only chunk list, and an open construct accumulates its
 * lines the same way instead of being re-read. Nothing already rendered is
 * re-parsed, re-walked or moved.
 */
export function advanceMdStream(state: MdStreamState, text: string, streaming: boolean): ReactNode {
  if (state.rendered !== null && text === state.source && streaming === state.streaming) return state.rendered;
  if (!reusable(state, text) && !recoverTrim(state, text, streaming)) resetMdStream(state);

  const rest = text.slice(state.stableChars);
  const lines = rest.split("\n");
  const complete = streaming ? lines.length - 1 : lines.length;
  let from = state.stableChars;
  for (let i = 0; i < complete; i++) {
    consume(state, lines[i], from);
    from += lines[i].length + 1;
    state.provisional = false;
  }
  if (complete > 0) {
    state.lineStart = from <= text.length;
    state.stableChars = Math.min(from, text.length);
    state.stableLines += complete;
    state.anchor = text.slice(Math.max(0, state.stableChars - ANCHOR), state.stableChars);
  }
  /* A completed message ends where it ends: an unclosed fence or a trailing run
     becomes its block, exactly as the transcript pass renders it. */
  if (!streaming && state.run) closeRun(state);

  let volatile_: ReactNode = null;
  if (streaming) {
    const last = lines[lines.length - 1];
    /* A message can stop ON its closing fence: that line has no newline yet,
       but the code between the fences is complete, and leaving the last block
       of an answer raw until the turn settles is the visible defect. */
    const closes = state.run?.kind === "fence" && FENCE_CLOSE_RE.test(last);
    if (closes !== state.provisional) {
      paintRun(state, closes);
      state.provisional = closes;
    }
    if (!closes) {
      const parts: ReactNode[] = [];
      if (state.sep) parts.push("\n");
      /* Inside a fence the tail is code; elsewhere the inline pass renders it,
         degrading to plain text for anything whose closer has not arrived.
         A line that is nothing BUT an image is left as text too: it becomes a
         thumbnail row when its newline lands, and embedding it inline first
         would only mount the image to throw it away a moment later. */
      const verbatim = state.run?.kind === "fence" || IMAGE_LINE_RE.test(last);
      parts.push(<Fragment key="v">{verbatim ? last : md(last)}</Fragment>);
      volatile_ = parts;
    }
  }

  const tree = <>{regionNodes(state.region)}{volatile_}</>;
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
  /* Held in state because it is grown across renders and must survive every one
     of them. Advancing it is idempotent, so a repeated render of the same text
     returns the same tree. */
  const [stream] = useState(createMdStream);
  return advanceMdStream(stream, text, streaming);
}
