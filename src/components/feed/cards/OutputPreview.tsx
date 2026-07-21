"use client";

import { useState } from "react";

import { ChevronUp } from "../../icons";
import { CopyButton } from "../CopyButton";
import { CodeBlock } from "../markdown";
import { tr } from "../parse";

/** Level-1 preview budget; "show all output" reveals the full capped string. */
const PREVIEW_LINES = 24;
const PREVIEW_CHARS = 4_096;

/**
 * Capped tool output with a lazy "show all" reveal, or — when the output is
 * absent — one compact dim chip that replaces the old apology paragraphs
 * (issue #9 §6). A `lang` hint upgrades the expanded body to highlighted code.
 */
export function OutputPreview({
  output,
  truncated,
  lang,
  copyLabel,
  heading,
  tone = "out",
  emptyLabel,
  emptyTip,
  showAllLabel,
}: {
  output: string;
  truncated: boolean;
  lang?: string | null;
  copyLabel?: string;
  /** Small stream label above the block (e.g. "stdout"/"stderr", issue #475). */
  heading?: string;
  /** `err` tints the block and heading for the stderr stream. */
  tone?: "out" | "err";
  emptyLabel?: string;
  emptyTip?: string;
  showAllLabel?: string;
}) {
  const [all, setAll] = useState(false);
  const label = heading ? (
    <div className={`mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${tone === "err" ? "text-danger" : "text-muted"}`}>{heading}</div>
  ) : null;
  if (!output.trim()) {
    return (
      <div className="mt-1.5">
        {label}
        <span className="text-[11px] text-muted" title={emptyTip ?? tr("tools.noOutputTip")}>
          {emptyLabel ?? tr("tools.noOutput")}
        </span>
      </div>
    );
  }
  const lines = output.split("\n");
  const overflow = lines.length > PREVIEW_LINES || output.length > PREVIEW_CHARS;
  const shown = all ? output : lines.slice(0, PREVIEW_LINES).join("\n").slice(0, PREVIEW_CHARS);
  /* stderr keeps a thin danger left-edge so the failing stream stays scannable
     without wrapping the whole block in its own bordered card. */
  const edge = tone === "err" ? "border-l-2 border-danger/50 pl-2" : "";
  return (
    <div className="group/out relative mt-1.5">
      {label}
      {all && lang ? (
        <CodeBlock code={shown} lang={lang} />
      ) : (
        <pre className={`max-h-[420px] max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] pr-8 font-mono text-[12px] text-secondary ${edge}`}>
          {shown}
        </pre>
      )}
      <CopyButton
        text={output}
        label={copyLabel ?? tr("tools.copyOutput")}
        className={`absolute right-0 opacity-0 transition-opacity motion-reduce:transition-none focus-visible:opacity-100 group-hover/out:opacity-100 [@media(hover:none)]:opacity-60 ${heading ? "top-5" : "top-0"}`}
      />
      {overflow ? (
        <button
          type="button"
          onClick={() => setAll((value) => !value)}
          className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {all ? (
            <>
              {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
            </>
          ) : (
            (showAllLabel ?? tr("tools.showOutput")) + (truncated ? " · " + tr("render.truncated") : "")
          )}
        </button>
      ) : truncated ? (
        <div className="mt-1 text-[11px] text-muted">{tr("render.truncated")}</div>
      ) : null}
    </div>
  );
}
