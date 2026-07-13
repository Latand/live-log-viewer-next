import { GlyphIcon } from "../../icons";
import { tr, type MemCitationItem } from "../parse";
import { FileRef } from "./shared";

export function MemCitationCard({ item }: { item: MemCitationItem }) {
  const visibleEntries = item.entries.slice(0, 8);
  const visibleIds = item.rolloutIds.slice(0, 6);
  return (
    <details className="group my-2 ml-9 overflow-hidden rounded-[14px] border border-border bg-card text-[12px] shadow-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-sunken">
          <GlyphIcon name="citation" className="h-4 w-4" />
        </span>
        <span className="text-[13px] font-semibold">{tr("render.memoryCitations", { count: item.entries.length })}</span>
        <span className="ml-auto text-[11px] font-semibold text-accent group-open:hidden">{tr("common.show")}</span>
        <span className="ml-auto hidden text-[11px] font-semibold text-accent group-open:inline">{tr("common.collapse")}</span>
      </summary>
      <div className="border-t border-border px-3.5 py-2.5">
        {visibleEntries.length ? (
          <div className="space-y-1.5">
            {visibleEntries.map((entry, idx) => (
              <div key={idx} className="min-w-0 rounded-[9px] bg-sunken px-2.5 py-1.5">
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
        <details className="mt-2 rounded-[10px] border border-border bg-sunken text-[12px]">
          <summary className="cursor-pointer list-none px-3 py-1.5 font-semibold text-muted">
            raw citation block{item.truncated ? " · " + tr("render.truncated") : ""}
          </summary>
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-mono text-[11.5px] text-secondary">
            {item.raw}
          </pre>
        </details>
      </div>
    </details>
  );
}
