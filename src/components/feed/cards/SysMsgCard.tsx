import { GlyphIcon } from "../../icons";
import { tr } from "../parse";

/** Harness/system turn folded into a thin expandable row: label + size, full text on demand. */
export function SysMsgCard({ label, text }: { label: string; text: string }) {
  const kb = text.length >= 2048 ? `${(text.length / 1024).toFixed(1)} ${tr("common.kb")}` : tr("common.chars", { n: text.length });
  return (
    <details className="group my-1.5 ml-9">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold text-dim hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex h-4.5 w-4.5 items-center justify-center rounded-md bg-chip">
          <GlyphIcon name="cmd-group" className="h-3 w-3" />
        </span>
        <span className="rounded-full bg-chip px-1.5 py-0.5 font-mono text-[9.5px]">{label}</span>
        <span>{tr("render.system")} · {kb}</span>
        <span className="text-accent group-open:hidden">{tr("common.show")}</span>
        <span className="hidden text-dim group-open:inline">{tr("common.collapse")}</span>
      </summary>
      <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11px] text-[#555]">
        {text}
      </pre>
    </details>
  );
}
