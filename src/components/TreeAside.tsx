"use client";

import { useState } from "react";

import { ChevronRight } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

import { FlipRow } from "./FlipRow";
import { activityDot, cleanTitle, engineBadge, fmtAge } from "./utils";

/** Dense collapsed strip of quiet childless conversations and finished loose tasks. */
export function ResidualStrip({ items, onSelect }: { items: FileEntry[]; onSelect: (file: FileEntry) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 border-t border-line bg-panel">
      <button
        className="flex h-8 items-center gap-2 px-4 text-[10px] font-bold uppercase tracking-[.6px] text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        Тихі розмови й задачі
        <span className="font-semibold normal-case tracking-normal">{items.length}</span>
      </button>
      {open ? (
        <FlipRow className="flex max-h-44 flex-wrap items-start gap-1.5 overflow-y-auto px-3 pb-2.5">
          {items.map((file) => {
            const badge = engineBadge(file);
            const title = cleanTitle(file.cmdDesc || file.title, 70);
            return (
              <button
                key={file.path}
                data-flip-key={file.path}
                className="inline-flex h-7 max-w-[360px] items-center gap-1.5 rounded-full border border-line bg-bg px-2 text-[11px] font-semibold text-ink hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                title={cleanTitle(file.title)}
                onClick={() => onSelect(file)}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
                <span className="shrink-0 rounded-full px-1.5 text-[9px]" style={badge.style}>{badge.label}</span>
                <span className="truncate">{title}</span>
                <span className="shrink-0 font-normal text-dim">{fmtAge(file.mtime)}</span>
              </button>
            );
          })}
        </FlipRow>
      ) : null}
    </div>
  );
}
