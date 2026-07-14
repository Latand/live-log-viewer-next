import { ChevronRight } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type TranscriptRecordItem } from "../parse";

/** Bounded fallback for rollout types introduced ahead of parser support. */
export function RecordCard({ item }: { item: TranscriptRecordItem }) {
  const time = hhmm(item.ts);
  return (
    <details className="group/record ml-9">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-control py-0.5 text-label text-muted hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open/record:rotate-90" aria-hidden />
        <span className="shrink-0 text-secondary">{tr("render.transcriptRecord")}</span>
        <span className="min-w-0 truncate rounded-md bg-sunken px-1.5 py-0.5 font-mono text-caption text-primary">{item.recordType}</span>
        {time ? <span className="ml-auto shrink-0 tabular-nums">{time}</span> : null}
      </summary>
      <div className="mb-1 mt-1 overflow-hidden rounded-surface border border-border bg-sunken">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-caption font-semibold text-muted">
          <span>{tr("render.recordDetails")}</span>
          {item.truncated ? <span className="rounded-md bg-card px-1.5 py-0.5">{tr("render.truncated")}</span> : null}
        </div>
        <pre className="max-h-[320px] max-w-full overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-secondary">{item.body}</pre>
      </div>
    </details>
  );
}
