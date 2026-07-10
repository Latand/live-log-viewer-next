"use client";

import { GlyphIcon } from "../../icons";
import { tr, type NestedCall, type Orchestration } from "../parse";

/* One inner operation of a functions.exec record: its icon and target/command
   summary. Four concurrent tools read as four distinct structured children.
   The transcript stores the combined result on the outer event and omits
   per-call status/output, so each child shows parsed data only. */
function NestedRow({ call }: { call: NestedCall }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-line bg-panel px-2.5 py-1 text-[11.5px]">
      <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md bg-chip">
        <GlyphIcon name={call.icon} className="h-3 w-3" />
      </span>
      <span className="min-w-0 flex-1 truncate" title={call.summary}>
        {call.summary}
      </span>
    </div>
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
