import { Fragment } from "react";
import type { ReactNode } from "react";

const MD_INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>"')\]]+)/g;

function Anchor({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      className="break-all text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </a>
  );
}

export function md(text: string): ReactNode {
  const parts = text.split(MD_INLINE_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`")) {
      return <span key={i} className="rounded-md bg-chip px-1.5 py-0.5 font-mono">{part.slice(1, -1)}</span>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    const linked = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (linked) {
      const href = linked[2].replace(/\\([()])/g, "$1");
      if (/^https?:\/\//.test(href)) return <Anchor key={i} href={href} label={linked[1]} />;
      return <span key={i} className="rounded-md bg-chip px-1.5 py-0.5 font-mono">{linked[1]}</span>;
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
      out.push(
        <pre key={`c${start}`} className="my-1.5 max-w-full overflow-x-auto rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11.5px]">
          {code}
        </pre>,
      );
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
