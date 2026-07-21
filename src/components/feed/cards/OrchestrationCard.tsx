"use client";

import { ChevronRight, GlyphIcon } from "../../icons";
import { tr, type NestedCall, type Orchestration } from "../parse";

/* One inner operation of a functions.exec record: its icon and target/command
   summary, rendered as a bare quiet line on the shared well. Four concurrent
   tools read as four distinct rows. The summary wraps so a long command stays
   fully visible. The transcript stores the combined result on the outer event
   and omits per-call status/output, so each child shows parsed data only. */
function NestedRow({ call }: { call: NestedCall }) {
  return (
    <div className="flex items-start gap-2 py-0.5 font-mono text-[11.5px] text-secondary">
      <GlyphIcon name={call.icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{call.summary}</span>
    </div>
  );
}

/** The structured detail of a `functions.exec` orchestration record: the nested
    calls (level 1) and the full JavaScript source (level 2). Both live flat on
    the parent's sunken well — a small stream label plus a hairline separator
    stand in for the old nested borders. */
export function OrchestrationCard({ orchestration, source }: { orchestration: Orchestration; source?: string }) {
  return (
    <div className="mt-1.5 space-y-1.5">
      {orchestration.calls.length ? (
        <div>
          <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{tr("tools.nestedCalls")}</div>
          {orchestration.calls.map((call, i) => (
            <NestedRow key={`${call.id}:${i}`} call={call} />
          ))}
        </div>
      ) : null}
      {orchestration.source.trim() || source?.trim() ? (
        <details className="group/src">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-semibold text-muted hover:text-accent [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 transition-transform group-open/src:rotate-90" aria-hidden />
            {tr("tools.source")}
          </summary>
          <pre className="mt-1 max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-t border-border pt-1.5 font-mono text-[11px]">
            {orchestration.source || source}
            {orchestration.sourceTruncated ? "\n…" : ""}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
