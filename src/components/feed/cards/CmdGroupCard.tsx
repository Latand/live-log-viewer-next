import { ChevronRight, GlyphIcon } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type CmdGroupItem } from "../parse";
import { DiffCard } from "./DiffCard";
import { OutputPreview } from "./OutputPreview";
import { StatusIcon } from "./shared";

/* A run of ≥2 consecutive tool events folded into one quiet ToolLine header
   (design doc §3.4): `▸ N дій · Tool ×a · Tool ×b · t0–t1`. Expanded, it lists
   the individual calls as quiet ToolLines. A group carrying an error opens by
   default and shows the failing line in danger — an error is never hidden. */
export function CmdGroupCard({ item }: { item: CmdGroupItem }) {
  const tools = Object.entries(item.byTool)
    .map(([tool, count]) => `${tool} ×${count}`)
    .join(" · ");
  const t0 = hhmm(item.t0);
  const t1 = hhmm(item.t1);
  const range = t0 && t1 && t0 !== t1 ? `${t0}–${t1}` : t0 || t1;
  return (
    <details className="group/grp ml-9" open={item.hasErr}>
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 rounded-control py-0.5 text-ui hover:bg-sunken [&::-webkit-details-marker]:hidden ${
          item.hasErr ? "text-danger" : "text-muted"
        }`}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open/grp:rotate-90" aria-hidden />
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-secondary">
          {tr("render.actions", { count: item.calls.length })}
          {tools ? " · " + tools : ""}
          {item.errCount ? (
            <span className="ml-1 inline-flex items-center gap-0.5 font-semibold text-danger">
              <StatusIcon status="err" className="h-3 w-3" />
              {item.errCount}
            </span>
          ) : null}
        </span>
        {range ? <span className="ml-auto shrink-0 text-caption tabular-nums text-muted">{range}</span> : null}
      </summary>
      <div className="mb-1 mt-1 space-y-0.5">
        {item.calls.map((event, idx) => {
          const isErr = event.status === "err";
          const statusCls = event.status === "ok" ? "text-success" : isErr ? "text-danger" : "text-muted";
          return (
            /* A transcript can carry the same tool id twice (a resume re-emits
               the tool_use), so the id alone is not a unique key. */
            <details key={`${item.ids[idx]}:${idx}`} open={event.open}>
              <summary
                className={`flex cursor-pointer list-none items-center gap-2 rounded-control py-0.5 text-ui hover:bg-sunken [&::-webkit-details-marker]:hidden ${
                  isErr ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1 text-danger" : "text-muted"
                }`}
              >
                <GlyphIcon name={event.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className={`min-w-0 flex-1 truncate ${isErr ? "font-semibold" : "text-secondary"}`} title={event.summary}>
                  {event.summary}
                </span>
                {event.status !== "ok" ? (
                  <span className={`ml-auto inline-flex shrink-0 items-center gap-1 text-caption font-semibold ${statusCls}`}>
                    <StatusIcon status={event.status} className="h-3 w-3" />
                    {event.statusLabel}
                  </span>
                ) : null}
              </summary>
              <div className="mb-1 mt-1 rounded-surface bg-sunken px-3 py-2">
                {event.command ? (
                  <pre className="max-w-full overflow-x-auto whitespace-pre rounded-control border border-border bg-card px-2.5 py-1 font-mono text-[11px]">
                    {"$ " + event.command}
                  </pre>
                ) : null}
                {event.body?.type === "diff" ? <DiffCard body={event.body} /> : null}
                {event.body?.type !== "diff" || event.outputPreview.trim() ? (
                  <OutputPreview output={event.outputPreview} truncated={event.outputTruncated} lang={event.lang} />
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}
