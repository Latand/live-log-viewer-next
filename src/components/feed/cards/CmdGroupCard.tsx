import { Check, GlyphIcon, X } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type CmdGroupItem } from "../parse";
import { StatusIcon } from "./shared";

export function CmdGroupCard({ item }: { item: CmdGroupItem }) {
  const tools = Object.entries(item.byTool)
    .map(([tool, count]) => `${tool} ×${count}`)
    .join(" · ");
  const t0 = hhmm(item.t0);
  const t1 = hhmm(item.t1);
  const range = t0 && t1 && t0 !== t1 ? `${t0}–${t1}` : t0 || t1;
  return (
    <details
      className={`my-2.5 ml-9 overflow-hidden rounded-[14px] border shadow-card ${item.hasErr ? "border-err/35 bg-[#fff4f4]" : "border-line bg-panel"}`}
      open={item.hasErr}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="cmd-group" className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[12.5px]">
          {tr("render.commands", { count: item.calls.length })}
          {tools ? " · " + tools : ""} ·
          <span className="inline-flex items-center gap-0.5 text-ok">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {item.okCount}
          </span>
          {item.errCount ? (
            <span className="inline-flex items-center gap-0.5 text-err">
              <X className="h-3.5 w-3.5" aria-hidden />
              {item.errCount}
            </span>
          ) : null}
        </span>
        {range ? <span className="ml-auto shrink-0 text-[11px] text-dim">{range}</span> : null}
      </summary>
      <div className="space-y-1 border-t border-line bg-[#fafafc] px-2 py-1.5">
        {item.calls.map((call, idx) => {
          const statusCls = call.status === "ok" ? "text-ok" : call.status === "err" ? "text-err" : "text-dim";
          return (
            <details key={item.ids[idx]} className="overflow-hidden rounded-[10px] border border-line bg-panel" open={call.open}>
              <summary className="flex h-6 cursor-pointer list-none items-center gap-2 px-2.5 text-[11.5px]">
                <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md bg-chip">
                  <GlyphIcon name={call.icon} className="h-3 w-3" />
                </span>
                <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-chip px-1.5 py-0.5 font-mono text-[11px]">
                  {call.display}
                </code>
                <span className={`ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${statusCls}`}>
                  <StatusIcon status={call.status} className="h-3 w-3" />
                  {call.label}
                </span>
              </summary>
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap border-t border-line bg-[#fafafc] px-3 py-2 font-mono text-[11.5px]">
                {"$ " + call.cmd + (call.output ? "\n" + call.output : "")}
              </pre>
            </details>
          );
        })}
      </div>
    </details>
  );
}
