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
        className="my-2 ml-9 flex items-center gap-2 rounded-surface border border-border bg-card px-3 py-1.5 text-[13px]"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-sunken">
          <GlyphIcon name="blob" className="h-3.5 w-3.5" />
        </span>
        <span className="font-semibold">{tr("render.dataKb", { n: kb })}</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">{tr("common.show")}</span>
      </button>
    );
  }
  return (
    <div className="my-2 ml-9 overflow-hidden rounded-surface border border-border bg-card">
      <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-all bg-sunken px-3 py-2 font-mono text-[11.5px]">
        {text}
      </pre>
      <button type="button" onClick={() => setOpen(false)} className="block w-full border-t border-border px-3 py-1.5 text-[12px] text-muted">
        {tr("common.collapse")}
      </button>
    </div>
  );
}
