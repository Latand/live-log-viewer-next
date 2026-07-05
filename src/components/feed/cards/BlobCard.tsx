"use client";

import { useState } from "react";

import { GlyphIcon } from "../../icons";
import { tr } from "../parse";

export function BlobCard({ bytes, text }: { bytes: number; text: string }) {
  const [open, setOpen] = useState(false);
  const kb = Math.round(bytes / 1024);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-2 ml-9 flex items-center gap-2 rounded-[14px] border border-line bg-panel px-3.5 py-2 text-[13px] shadow-card"
      >
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="blob" className="h-4 w-4" />
        </span>
        <span className="font-semibold">{tr("render.dataKb", { n: kb })}</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">{tr("common.show")}</span>
      </button>
    );
  }
  return (
    <div className="my-2 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card">
      <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-all bg-[#fafafc] px-3.5 py-2.5 font-mono text-[11.5px]">
        {text}
      </pre>
      <button type="button" onClick={() => setOpen(false)} className="block w-full border-t border-line px-3.5 py-1.5 text-[12px] text-dim">
        {tr("common.collapse")}
      </button>
    </div>
  );
}
