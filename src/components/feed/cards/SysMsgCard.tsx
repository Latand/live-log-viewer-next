import { ChevronRight } from "../../icons";
import { tr } from "../parse";

/** Harness/system turn folded into one quiet line — `› системне · 1.4k`
    (design doc §3.4). The label chip and full text appear only when expanded. */
export function SysMsgCard({ label, text }: { label: string; text: string }) {
  const kb = text.length >= 2048 ? `${(text.length / 1024).toFixed(1)} ${tr("common.kb")}` : tr("common.chars", { n: text.length });
  return (
    <details className="group ml-9">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-control py-0.5 text-label text-muted hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <span className="truncate text-secondary">
          {tr("render.system")} · {kb}
        </span>
      </summary>
      <div className="mb-1 mt-1">
        <span className="mb-1 inline-flex items-center rounded-control bg-sunken px-1.5 py-0.5 font-mono text-caption text-muted">{label}</span>
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-surface border border-border bg-sunken px-3 py-2 font-mono text-[11px] text-secondary">
          {text}
        </pre>
      </div>
    </details>
  );
}
