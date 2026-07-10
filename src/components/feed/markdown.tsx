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
      className={`cursor-copy rounded-md px-1.5 py-0.5 font-mono ${copied ? "bg-ok/15 text-ok" : "bg-chip"}`}
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
          className="hljs max-w-full overflow-x-auto rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11.5px]"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre className="max-w-full overflow-x-auto rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11.5px]">{code}</pre>
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
        className="my-1 max-h-[240px] max-w-full cursor-zoom-in rounded-[10px] border border-line align-top"
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
                <th key={i} className="border border-line bg-chip px-2.5 py-1 text-left font-semibold">
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
                <td key={j} className="border border-line px-2.5 py-1 align-top">
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

/* Block-level pass for whole prose messages rendered inside whitespace-pre-wrap:
   newlines survive as text; tables group into real <table>, headings and
   blockquotes are styled per line, everything else goes through the inline pass. */
export function mdBlocks(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
      const code = lines.slice(start + 1, i).join("\n");
      if (i < lines.length) i++;
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<CodeBlock key={`c${start}`} code={code} />);
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
        <span key={i} className="border-l-2 border-line pl-2 text-dim">
          {md(quote[1])}
        </span>,
      );
    } else {
      out.push(<Fragment key={i}>{md(line)}</Fragment>);
    }
    i++;
    if (i < lines.length) out.push("\n");
  }
  return out;
}
