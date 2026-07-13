import { ChevronRight } from "../../icons";
import { tr } from "../parse";

/** Harness/system turn folded into one quiet line — `› системне · 1.4k`
    (design doc §3.4). The label chip and full text appear only when expanded. */
export function SysMsgCard({ label, text }: { label: string; text: string }) {
  /* Compact per-1000 size (design doc §3.4: `› системне · 1.4k`) — a 1,402-char
     turn reads `1.4k`, not `1402 chars` / `1.4 kB`. Small turns keep a bare count. */
  const size = text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k` : String(text.length);
  return (
    <details className="group ml-9">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-control py-0.5 text-label text-muted hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <span className="truncate text-secondary">
          {tr("render.system")} · {size}
        </span>
      </summary>
      <div className="mb-1 mt-1">
        <span className="mb-1 inline-flex items-center rounded-control bg-sunken px-1.5 py-0.5 font-mono text-caption text-muted">{label}</span>
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-surface border border-border bg-sunken px-3 py-2 font-mono text-label text-secondary">
          {text}
        </pre>
      </div>
    </details>
  );
}
