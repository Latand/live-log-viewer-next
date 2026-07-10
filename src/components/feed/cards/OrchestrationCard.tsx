"use client";

import { GlyphIcon } from "../../icons";
import { tr, type NestedCall, type Orchestration } from "../parse";
import { OutputPreview } from "./OutputPreview";
import { StatusIcon } from "./shared";

function statusClass(status: NestedCall["status"]): string {
  return status === "ok" ? "text-ok" : status === "err" ? "text-err" : "text-dim";
}

/* One inner operation of a functions.exec record: its own icon, target/command
   summary, status, and bounded output — so four concurrent tools read as four
   distinct structured children instead of one repeated flat row. */
function NestedRow({ call }: { call: NestedCall }) {
  return (
    <details className="overflow-hidden rounded-[10px] border border-line bg-panel" open={call.status === "err"}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1 text-[11.5px]">
        <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md bg-chip">
          <GlyphIcon name={call.icon} className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate" title={call.summary}>
          {call.summary}
        </span>
        <span className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${statusClass(call.status)}`}>
          <StatusIcon status={call.status} className="h-3 w-3" />
          {call.statusLabel}
        </span>
      </summary>
      <div className="border-t border-line px-2.5 py-1.5">
        <OutputPreview output={call.outputPreview} truncated={call.outputTruncated} />
      </div>
    </details>
  );
}

/** The structured detail of a `functions.exec` orchestration record: the nested
    calls (level 1) and the full JavaScript source (level 2). */
export function OrchestrationCard({ orchestration, source }: { orchestration: Orchestration; source?: string }) {
  return (
    <div className="mt-1.5 space-y-1.5">
      {orchestration.calls.length ? (
        <div className="space-y-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-dim">{tr("tools.nestedCalls")}</div>
          {orchestration.calls.map((call, i) => (
            <NestedRow key={`${call.id}:${i}`} call={call} />
          ))}
        </div>
      ) : null}
      {orchestration.source || source ? (
        <details className="overflow-hidden rounded-[10px] border border-line bg-panel-alt">
          <summary className="cursor-pointer list-none px-2.5 py-1 text-[11px] font-semibold text-dim">{tr("tools.source")}</summary>
          <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre border-t border-line px-3 py-2 font-mono text-[11px]">
            {orchestration.source || source}
            {orchestration.sourceTruncated ? "\n…" : ""}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
