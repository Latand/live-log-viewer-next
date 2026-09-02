"use client";

import { useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { ChevronDown, ChevronRight } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type CmdGroupItem, type ToolEvent } from "../parse";
import { elapsedDurationMs, formatDuration } from "../duration";
import { coalesceFollowUps, groupNestedCalls } from "../toolBlocks";
import { StatusIcon } from "./shared";
import { MobileRunRow, PollRow, ToolBlockRow, ToolLine, isPendingQuestionCall, mobileClock } from "./ToolCard";

/* The ordered list of readable blocks an opened run shows — one per top-level
   call, wait/stdin follow-ups nested under the exec that owns them (issue
   #475). Shared by the desktop group and the phone's expanded run so the two
   never drift. Mounted only while open (issue #9 §7/§8). A transcript can carry
   the same tool id twice (a resume re-emits the tool_use), so the id alone is
   not a unique key. */
function ReadableBlocks({ calls }: { calls: readonly ToolEvent[] }) {
  const blocks = groupNestedCalls(calls);
  return (
    <ol className="mb-1 mt-1 space-y-0.5">
      {blocks.map((block, bi) => {
        /* Consecutive empty polls coalesce into one compact counted row; a
           keystroke write_stdin or an output-bearing wait stays a full
           readable follow-up (issue #497). */
        const children = coalesceFollowUps(block.children);
        return (
          <li key={`${block.parent.id}:${bi}`} className="min-w-0">
            <ToolBlockRow event={block.parent} index={bi + 1} />
            {children.length ? (
              <div className="ml-4 border-l border-border pl-2">
                {children.map((child, ci) =>
                  child.kind === "polls" ? (
                    <PollRow key={`poll:${ci}`} events={child.events} session={child.session} elapsedMs={child.elapsedMs} />
                  ) : (
                    <ToolBlockRow key={`${child.event.id}:${ci}`} event={child.event} nested />
                  ),
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* Mobile v2 (#1439, lane 4; README §2.6, §4.2): on the phone tool calls are
   chrome. A clean run of ≥ 2 settled calls folds to one 44 px line with counts
   (`Read ×2 · Grep`, the ×1 dropped), and the call still running stays its own
   last line so the operator always sees what the agent is doing now. A run
   with a failure is one sunken block whose lines are 36 px list items, the
   failed one carrying its detail; the block is the target and expands in place
   into the readable blocks. The live `active` flag does not force the phone
   open: the operator's tap does. */
function mobileToolSummary(calls: readonly ToolEvent[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const tool = call.tool || call.family;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => (count > 1 ? `${tool} ×${count}` : tool)).join(" · ");
}

function MobileCmdGroup({ item }: { item: CmdGroupItem }) {
  const [open, setOpen] = useState(false);
  const calls = item.calls;
  const last = calls[calls.length - 1];
  const trailingRun = last && last.status === "run" ? last : null;
  const done = trailingRun ? calls.slice(0, -1) : calls;
  /* A run that ends in the pending question shows no line for it: the
     question card under the feed is that line. */
  const trailingLine = trailingRun && !isPendingQuestionCall(trailingRun) ? trailingRun : null;
  if (item.hasErr) {
    return (
      <div data-mobile-run="failed" className="my-1.5 w-full rounded-control border border-border bg-sunken px-2 py-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={tr("mobile2.feed.runFailed", { count: calls.length, failed: item.errCount })}
          className="block w-full text-left"
          onClick={() => setOpen((current) => !current)}
        >
          {calls.map((call, index) => (
            <MobileRunRow key={`${call.id}:${index}`} event={call} />
          ))}
        </button>
        {open ? <ReadableBlocks calls={calls} /> : null}
      </div>
    );
  }
  const first = done[0];
  const lastDone = done[done.length - 1];
  const t0 = mobileClock(first?.ts);
  const t1 = mobileClock(lastDone?.endTs ?? lastDone?.ts);
  const range = t0 && t1 && t0 !== t1 ? `${t0}–${t1}` : t0 || t1;
  const tools = mobileToolSummary(done);
  return (
    <div data-mobile-run={trailingRun ? "running" : "done"} className="w-full">
      {done.length >= 2 ? (
        <>
          <button
            type="button"
            data-mobile-run-fold
            aria-expanded={open}
            aria-label={tr("mobile2.feed.runFold", { count: done.length })}
            className="flex min-h-11 w-full items-center gap-1.5 rounded-control px-0.5 text-left text-ui text-muted"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate text-secondary">
              {tr("render.actions", { count: done.length })}
              {tools ? " · " + tools : ""}
            </span>
            {range ? <span className="shrink-0 text-caption tabular-nums">{range}</span> : null}
          </button>
          {open ? (
            <div className="mb-1.5 rounded-control border border-border bg-sunken px-2 py-0.5">
              <ReadableBlocks calls={done} />
            </div>
          ) : null}
        </>
      ) : first ? (
        <ToolLine event={first} />
      ) : null}
      {trailingLine ? <ToolLine event={trailingLine} /> : null}
    </div>
  );
}

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
  const isMobile = useIsMobile();
  if (isMobile) return <MobileCmdGroup item={item} />;
  return <DesktopCmdGroup item={item} />;
}

function DesktopCmdGroup({ item }: { item: CmdGroupItem }) {
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
  const durationMs = elapsedDurationMs(item.t0, item.t1);
  const duration = durationMs === null ? "" : formatDuration(durationMs);
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
        {duration ? <span className="shrink-0 text-caption tabular-nums text-muted">{duration}</span> : null}
        {range ? <span className="shrink-0 text-caption tabular-nums text-muted">{range}</span> : null}
      </summary>
      {/* An ordered list of readable blocks. Each call renders inline via
          {@link ToolBlockRow} — its command and output are shown at once, with no
          per-call disclosure to click. Mounted only while open, so a collapsed
          transcript keeps its DOM small (issue #9 §7/§8). */}
      {open ? <ReadableBlocks calls={item.calls} /> : null}
    </details>
  );
}
