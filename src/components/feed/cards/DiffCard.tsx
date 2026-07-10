"use client";

import { useState } from "react";

import { ChevronUp } from "../../icons";
import { CopyButton } from "../CopyButton";
import { tr, type ToolBody } from "../parse";
import { FileRef } from "./shared";
import type { DiffLine, FileDiff, Hunk } from "../diff";

/** Level-1 visible-line budget per file; "show all" reveals the capped rest. */
const PREVIEW_LINES = 10;

const OP_TONE: Record<FileDiff["op"], string> = {
  add: "text-diff-add",
  update: "text-accent",
  delete: "text-diff-del",
  move: "text-accent",
};

function humanKb(chars: number): string {
  return `${Math.max(1, Math.round(chars / 1024))} kB`;
}

function flatten(hunks: Hunk[]): { line: DiffLine; header?: string }[] {
  const out: { line: DiffLine; header?: string }[] = [];
  for (const hunk of hunks) {
    let first = true;
    for (const line of hunk.lines) {
      out.push({ line, header: first ? hunk.header : undefined });
      first = false;
    }
  }
  return out;
}

function LineRow({ line }: { line: DiffLine }) {
  const tone =
    line.t === "+"
      ? "bg-diff-add-soft text-diff-add"
      : line.t === "-"
        ? "bg-diff-del-soft text-diff-del"
        : "text-ink";
  return (
    <div className={`whitespace-pre px-2 ${tone}`}>
      {/* The +/- marker is real text content, so screen readers and copy keep it. */}
      {line.t}
      {line.text || " "}
    </div>
  );
}

function FileDiffView({ file }: { file: FileDiff }) {
  const [all, setAll] = useState(false);
  const rows = flatten(file.hunks);
  const overflow = rows.length > PREVIEW_LINES;
  const visible = all ? rows : rows.slice(0, PREVIEW_LINES);
  const copyText = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.t + line.text)).join("\n");
  return (
    <div className="group/diff relative overflow-hidden rounded-[10px] border border-line bg-panel-alt">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1 text-[11.5px]">
        <span className={`shrink-0 font-semibold uppercase ${OP_TONE[file.op]}`}>{file.op}</span>
        <span className="min-w-0 flex-1 truncate">
          <FileRef file={file.path} />
        </span>
        {file.binary ? null : (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-diff-add">+{file.added}</span> <span className="text-diff-del">−{file.removed}</span>
          </span>
        )}
        {copyText ? (
          <CopyButton
            text={copyText}
            label={tr("tools.copyDiff")}
            className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/diff:opacity-100 [@media(hover:none)]:opacity-60"
          />
        ) : null}
      </div>
      {file.binary ? (
        <div className="px-2.5 py-2 text-[11.5px] text-dim">{tr("tools.binaryContent", { size: humanKb(file.added + file.removed) })}</div>
      ) : rows.length ? (
        <>
          <div className="max-w-full overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.5]">
            {visible.map(({ line, header }, i) => (
              <div key={i}>
                {header ? <div className="whitespace-pre px-2 text-dim">{`@@ ${header}`}</div> : null}
                <LineRow line={line} />
              </div>
            ))}
          </div>
          {overflow ? (
            <button
              type="button"
              onClick={() => setAll((value) => !value)}
              className="w-full border-t border-line px-2.5 py-1 text-left text-[11px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {all ? (
                <span className="inline-flex items-center gap-1">
                  {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
                </span>
              ) : (
                tr("tools.showAllLines", { count: rows.length })
              )}
            </button>
          ) : null}
        </>
      ) : null}
      {file.truncated ? <div className="border-t border-line px-2.5 py-0.5 text-[10.5px] text-dim">{tr("tools.diffTruncated")}</div> : null}
    </div>
  );
}

export function DiffCard({ body }: { body: Extract<ToolBody, { type: "diff" }> }) {
  return (
    <div className="mt-1.5 space-y-1.5">
      {body.files.map((file, i) => (
        <FileDiffView key={`${file.path}:${i}`} file={file} />
      ))}
      {body.filesTruncated ? <div className="text-[11px] text-dim">{tr("tools.moreFiles", { count: body.files.length })}</div> : null}
    </div>
  );
}
