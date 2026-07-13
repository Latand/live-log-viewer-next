import { GlyphIcon } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type Item } from "../parse";

/** Compaction marker: a full-width band the eye catches while scrolling —
    the context was condensed here, everything above predates the squeeze.
    The Claude summary (when present) unfolds beneath it on demand. */
export function CompactBand({ item }: { item: Extract<Item, { kind: "compact" }> }) {
  const detail = [
    item.trigger ? tr(item.trigger === "auto" ? "render.compactAuto" : "render.compactManual") : "",
    item.preTokens ? tr("render.compactPre", { n: Math.round(item.preTokens / 1000) }) : "",
    hhmm(item.ts) || "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="my-3.5">
      <div className="flex items-center gap-2.5">
        <span className="h-px flex-1 bg-[#0d9488]/30" aria-hidden />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#0d9488]/30 bg-[#e7f6f4] px-2.5 py-1 text-[11px] font-bold text-[#0b7c72]">
          <GlyphIcon name="compact" className="h-3.5 w-3.5" />
          {tr("render.compacted")}
          {detail ? <span className="font-semibold tabular-nums opacity-75">{detail}</span> : null}
        </span>
        <span className="h-px flex-1 bg-[#0d9488]/30" aria-hidden />
      </div>
      {item.summary ? (
        <details className="group/cmp mt-1.5 text-center">
          <summary className="cursor-pointer list-none text-[11px] font-semibold text-[#0b7c72] [&::-webkit-details-marker]:hidden">
            <span className="group-open/cmp:hidden">
              {tr("render.compactSummary")} · {tr("common.show")}
            </span>
            <span className="hidden group-open/cmp:inline">{tr("common.collapse")}</span>
          </summary>
          <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-bg px-3 py-2 text-left font-mono text-[11px] text-[#555]">
            {item.summary}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
