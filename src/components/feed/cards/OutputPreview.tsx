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
}: {
  output: string;
  truncated: boolean;
  lang?: string | null;
  copyLabel?: string;
}) {
  const [all, setAll] = useState(false);
  if (!output.trim()) {
    return (
      <div className="mt-1.5">
        <span className="inline-flex items-center rounded-md bg-chip px-2 py-0.5 text-[11px] text-dim" title={tr("tools.noOutputTip")}>
          {tr("tools.noOutput")}
        </span>
      </div>
    );
  }
  const lines = output.split("\n");
  const overflow = lines.length > PREVIEW_LINES || output.length > PREVIEW_CHARS;
  const shown = all ? output : lines.slice(0, PREVIEW_LINES).join("\n").slice(0, PREVIEW_CHARS);
  return (
    <div className="group/out relative mt-1.5">
      {all && lang ? (
        <CodeBlock code={shown} lang={lang} />
      ) : (
        <pre className="max-h-[420px] max-w-full overflow-auto whitespace-pre rounded-[10px] border border-line bg-panel-alt px-3 py-2 font-mono text-[12px]">
          {shown}
        </pre>
      )}
      <CopyButton
        text={output}
        label={copyLabel ?? tr("tools.copyOutput")}
        className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/out:opacity-100 [@media(hover:none)]:opacity-60"
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
            tr("tools.showOutput") + (truncated ? " · " + tr("render.truncated") : "")
          )}
        </button>
      ) : truncated ? (
        <div className="mt-1 text-[11px] text-dim">{tr("render.truncated")}</div>
      ) : null}
    </div>
  );
}
