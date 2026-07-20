"use client";

import { useState } from "react";

import { ChevronRight } from "../../icons";
import { hhmm } from "../../utils";
import { tr, type CmdGroupItem } from "../parse";
import { groupNestedCalls } from "../toolBlocks";
import { StatusIcon } from "./shared";
import { ToolLine } from "./ToolCard";

/* A run of ≥2 consecutive tool events folded into one quiet ToolLine header
   (design doc §3.4): `▸ N дій · Tool ×a · Tool ×b · t0–t1`. Expanded, it lists
   the individual calls as quiet ToolLines. A group carrying an error opens by
   default and shows the failing line in danger — an error is never hidden. */
export function CmdGroupCard({ item }: { item: CmdGroupItem }) {
  /* Children (and their diff / output / raw-record bodies) mount only after the
     group is first expanded. A diff-backed child sets open:true, so rendering it
     inside a still-collapsed group would eagerly build the hidden body and break
     the §3.4 lazy contract for long edit runs (issue #9 §7/§8). An error group
     opens by default, so it mounts immediately. */
  const [mounted, setMounted] = useState(item.hasErr);
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
      open={item.hasErr}
      onToggle={(e) => {
        if (e.currentTarget.open) setMounted(true);
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
      {/* Each grouped call reuses the shared ToolLine, so an expanded call shows
          the same readable block a standalone line does. Blocks are an ordered
          list; a wait/stdin follow-up renders nested under its parent exec while
          keeping its own state. The time is dropped — the range lives in the
          header above. A transcript can carry the same tool id twice (a resume
          re-emits the tool_use), so the id alone is not a unique key. */}
      {mounted ? (
        <ol className="mb-1 mt-1 space-y-0.5">
          {blocks.map((block, bi) => (
            <li key={`${block.parent.id}:${bi}`} className="min-w-0">
              <ToolLine event={block.parent} showTime={false} index={bi + 1} />
              {block.children.length ? (
                <div className="ml-4 border-l border-border pl-2">
                  {block.children.map((child, ci) => (
                    <ToolLine key={`${child.id}:${ci}`} event={child} showTime={false} nested />
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
