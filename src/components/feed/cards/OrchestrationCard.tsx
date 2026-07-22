"use client";

import { GlyphIcon } from "../../icons";
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
    calls, flat on the parent's sunken well. The raw JavaScript source disclosure
    was dropped in the compact-feed pass — the parsed rows already carry the
    meaning, and the "source" toggle was noise the operator never opens. */
export function OrchestrationCard({ orchestration }: { orchestration: Orchestration; source?: string }) {
  if (!orchestration.calls.length) return null;
  return (
    <div className="mt-1.5 space-y-1.5">
      <div>
        <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{tr("tools.nestedCalls")}</div>
        {orchestration.calls.map((call, i) => (
          <NestedRow key={`${call.id}:${i}`} call={call} />
        ))}
      </div>
    </div>
  );
}
