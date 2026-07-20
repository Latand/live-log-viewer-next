"use client";

import { useState } from "react";

import { ChevronRight } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type CmdGroupItem } from "../parse";
import { groupNestedCalls } from "../toolBlocks";
import { StatusIcon } from "./shared";
import { ToolBlockRow } from "./ToolCard";

/* A run of ≥2 consecutive tool events folded into one quiet ToolLine header
   (design doc §3.4): `▸ N дій · Tool ×a · Tool ×b · t0–t1`.

   Lifecycle parity with Claude's UPDATE cards (issue #475): while the run is the
   live trailing aggregate (`item.active`) the group is forced open and its body
   shows every command and its owned output at once — no nested disclosure. When
   the run settles (`active` flips to false) the group auto-collapses exactly once
   to the compact summary; after that the operator's manual open/close wins and
   persists across live ticks. A settled group that carries an error opens by
   default so a failure is never hidden, and its count stays on the compact
   summary line even when collapsed. */
export function CmdGroupCard({ item }: { item: CmdGroupItem }) {
  const active = item.active;
  /* The operator's manual choice once the group has settled. `null` means "no
     manual choice yet", so the default (error → open, else collapsed) applies. */
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  /* The single auto-collapse: detect the first live→settled transition during
     render (the React-blessed "adjust state on prop change" pattern) so the
     collapse is applied before the DOM ever shows the settled group open. A
     never-active (historical) group never triggers it, so it keeps its error-open
     default. `collapsedOnce` latches after that first collapse so a later
     activity cycle (settled → live → settled again) can never re-collapse: past
     the initial collapse the operator's latest open/closed choice always wins. */
  const [wasActive, setWasActive] = useState(active);
  const [collapsedOnce, setCollapsedOnce] = useState(false);
  if (wasActive !== active) {
    setWasActive(active);
    if (wasActive && !active && !collapsedOnce) {
      setCollapsedOnce(true);
      setManualOpen(false);
    }
  }

  /* Active → always open; settled → the operator's choice, else the error
     default. */
  const open = active ? true : (manualOpen ?? item.hasErr);

  const tools = Object.entries(item.byTool)
    .map(([tool, count]) => `${tool} ×${count}`)
    .join(" · ");
  const t0 = hhmm(item.t0);
  const t1 = hhmm(item.t1);
  const range = t0 && t1 && t0 !== t1 ? `${t0}–${t1}` : t0 || t1;
  /* One ordered block per top-level call, with any trailing wait/stdin polls
     nested under the exec that owns them (issue #475). */
  const blocks = groupNestedCalls(item.calls);
  return (
    <details
      className="group/grp ml-9"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        /* While live the aggregate stays open: undo an operator's collapse
           attempt (React won't re-assert an unchanged `open` prop, so reset the
           DOM node directly) instead of recording it. */
        if (active) {
          if (!next) e.currentTarget.open = true;
          return;
        }
        if (next !== open) setManualOpen(next);
      }}
    >
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 rounded-control py-0.5 text-ui hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden ${
          item.hasErr ? "text-danger" : "text-muted"
        }`}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none group-open/grp:rotate-90" aria-hidden />
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
      {/* An ordered list of readable blocks. Each call renders inline via
          {@link ToolBlockRow} — its command and output are shown at once, with no
          per-call disclosure to click — and a wait/stdin follow-up renders nested
          under its parent exec while keeping its own state. Mounted only while
          open, so a collapsed transcript keeps its DOM small (issue #9 §7/§8). A
          transcript can carry the same tool id twice (a resume re-emits the
          tool_use), so the id alone is not a unique key. */}
      {open ? (
        <ol className="mb-1 mt-1 space-y-0.5">
          {blocks.map((block, bi) => (
            <li key={`${block.parent.id}:${bi}`} className="min-w-0">
              <ToolBlockRow event={block.parent} index={bi + 1} />
              {block.children.length ? (
                <div className="ml-4 border-l border-border pl-2">
                  {block.children.map((child, ci) => (
                    <ToolBlockRow key={`${child.id}:${ci}`} event={child} nested />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}
