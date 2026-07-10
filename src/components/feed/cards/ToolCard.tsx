"use client";

import { useState } from "react";

import { debugRaw } from "@/lib/review";

import { GlyphIcon } from "../../icons";
import { hhmm } from "../../utils";
import { CopyButton } from "../CopyButton";
import { tr, type ToolEvent } from "../parse";
import type { ArgChip } from "../tools";
import { useRawLine } from "../rawLine";
import { DiffCard } from "./DiffCard";
import { OrchestrationCard } from "./OrchestrationCard";
import { OutputPreview } from "./OutputPreview";
import { StatusIcon } from "./shared";

function statusClass(status: ToolEvent["status"]): string {
  return status === "ok" ? "text-ok" : status === "err" ? "text-err" : "text-dim";
}

export function ToolChips({ chips }: { chips: ArgChip[] }) {
  if (!chips.length) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((chip, i) => (
        <span key={i} className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-chip px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {chip.label ? <span className="text-dim">{chip.label}</span> : null}
          {chip.value}
        </span>
      ))}
    </div>
  );
}

/* Level-2 provenance: the redacted raw source line(s) resolved lazily and
   client-side from the retained window. Slid out of the window → a quiet chip.
   The call id is exposed for diagnosis and copy. */
function RawRecord({ event }: { event: ToolEvent }) {
  const getRaw = useRawLine();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 text-[11px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {tr("tools.rawRecord")}
      </button>
    );
  }
  const indices = [event.srcCall, event.srcResult].filter((n): n is number => typeof n === "number");
  const raw = indices.map((n) => getRaw(n)).filter((line): line is string => line !== null);
  const record = raw.length ? debugRaw(raw.join("\n")).raw : "";
  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10.5px] text-dim">
        <span className="font-mono">{tr("tools.callId", { id: event.id })}</span>
        <CopyButton text={event.id} label={tr("tools.copyId")} className="p-0.5" />
      </div>
      {record ? (
        <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre rounded-[10px] border border-line bg-panel-alt px-3 py-2 font-mono text-[11px]">{record}</pre>
      ) : (
        <span className="inline-flex items-center rounded-md bg-chip px-2 py-0.5 text-[11px] text-dim">{tr("tools.noRawRecord")}</span>
      )}
    </div>
  );
}

/** One normalized tool event. The summary row is always in the DOM; the body
    (chips, diff/output, raw record) mounts only after the first expand, keeping
    a long transcript's collapsed DOM small (issue #9 §7/§8). */
export function ToolCard({ event }: { event: ToolEvent }) {
  const [mounted, setMounted] = useState(event.open);
  const time = hhmm(event.ts);
  const hasDiff = event.body?.type === "diff";
  const showOutput = !hasDiff || Boolean(event.outputPreview.trim());
  return (
    <details
      className="group/tool my-2.5 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card"
      open={event.open}
      onToggle={(e) => {
        if (e.currentTarget.open) setMounted(true);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name={event.icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={event.summary}>
          {event.summary}
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${statusClass(event.status)}`}>
          <StatusIcon status={event.status} />
          {event.statusLabel}
        </span>
        {time ? <span className="shrink-0 text-[11px] text-dim">{time}</span> : null}
      </summary>
      {mounted ? (
        <div className="border-t border-line px-3.5 py-2.5">
          <ToolChips chips={event.chips} />
          {event.command ? (
            <pre className="max-w-full overflow-x-auto whitespace-pre rounded-[10px] border border-line bg-panel-alt px-3 py-1.5 font-mono text-[12px]">
              {"$ " + event.command}
            </pre>
          ) : null}
          {event.orchestration ? <OrchestrationCard orchestration={event.orchestration} source={event.command} /> : null}
          {hasDiff && event.body?.type === "diff" ? <DiffCard body={event.body} /> : null}
          {showOutput ? <OutputPreview output={event.outputPreview} truncated={event.outputTruncated} lang={event.lang} /> : null}
          <RawRecord event={event} />
        </div>
      ) : null}
    </details>
  );
}
