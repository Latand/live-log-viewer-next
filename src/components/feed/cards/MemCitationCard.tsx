import { ChevronRight, GlyphIcon } from "../../icons";
import { tr, type MemCitationItem } from "../parse";
import { FileRef } from "./shared";

export function MemCitationCard({ item }: { item: MemCitationItem }) {
  const visibleEntries = item.entries.slice(0, 8);
  const visibleIds = item.rolloutIds.slice(0, 6);
  return (
    <details className="group my-2 ml-9 overflow-hidden rounded-surface border border-border bg-card text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sunken">
          <GlyphIcon name="citation" className="h-3.5 w-3.5" />
        </span>
        <span className="text-[13px] font-semibold">{tr("render.memoryCitations", { count: item.entries.length })}</span>
        <span className="ml-auto text-[11px] font-semibold text-accent group-open:hidden">{tr("common.show")}</span>
        <span className="ml-auto hidden text-[11px] font-semibold text-accent group-open:inline">{tr("common.collapse")}</span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        {visibleEntries.length ? (
          <div className="divide-y divide-border">
            {visibleEntries.map((entry, idx) => (
              <div key={idx} className="min-w-0 py-1.5 first:pt-0 last:pb-0">
                <FileRef file={entry.target} line={entry.line ? Number(entry.line.split("-", 1)[0]) : undefined} />
                {entry.note ? <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-secondary">{entry.note}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-muted">{tr("render.noCitations")}</div>
        )}
        {item.entries.length > visibleEntries.length ? (
          <div className="mt-1.5 text-[12px] text-muted">{tr("render.moreEntries", { count: item.entries.length - visibleEntries.length })}</div>
        ) : null}
        {visibleIds.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted">rollout:</span>
            {visibleIds.map((id) => (
              <code key={id} className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[10.5px] text-muted" title={id}>
                {id.slice(0, 8)}
              </code>
            ))}
            {item.rolloutIds.length > visibleIds.length ? <span className="text-[11px] text-muted">+{item.rolloutIds.length - visibleIds.length}</span> : null}
          </div>
        ) : null}
        <details className="group/raw mt-2 text-[12px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-semibold text-muted hover:text-accent [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 transition-transform group-open/raw:rotate-90" aria-hidden />
            raw citation block{item.truncated ? " · " + tr("render.truncated") : ""}
          </summary>
          <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-t border-border pt-1.5 font-mono text-[11.5px] text-secondary">
            {item.raw}
          </pre>
        </details>
      </div>
    </details>
  );
}
