"use client";

import { useMemo, useState } from "react";

import { ChevronRight, Layers } from "@/components/icons";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { FlipRow } from "./FlipRow";
import { VERDICT_GLYPHS } from "./flows/flowModel";
import type { WorkerStack } from "./scheme/workerCollapse";
import { activityDot, engineBadge, fmtAge } from "./utils";

/** Verdict glyph for a folded reviewer round, resolved through the flows list by
    path (never `file.flow`, which /api/files does not populate). */
function reviewerVerdict(file: FileEntry, flows: readonly Flow[]): string | null {
  for (const flow of flows) {
    const round = flow.rounds.find((item) => item.reviewerPath === file.path);
    if (round) return round.verdict ? VERDICT_GLYPHS[round.verdict] : null;
  }
  return null;
}

function StackRow({
  stack,
  label,
  flows,
  onSelect,
}: {
  stack: WorkerStack;
  label: string;
  flows: readonly Flow[];
  onSelect: (file: FileEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        className="flex h-7 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[11px] font-bold text-ink hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        <Layers className="h-3 w-3 shrink-0 text-dim" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 rounded-full bg-accent/10 px-1.5 text-[9.5px] font-bold text-accent">{stack.items.length}</span>
      </button>
      {open ? (
        <FlipRow className="mt-1 flex flex-wrap items-start gap-1.5 pb-1 pl-5">
          {stack.items.map((file) => {
            const badge = engineBadge(file);
            const verdict = reviewerVerdict(file, flows);
            return (
              <button
                key={file.path}
                data-flip-key={file.path}
                className="inline-flex h-7 max-w-[340px] items-center gap-1.5 rounded-full border border-line bg-bg px-2 text-[11px] font-semibold text-ink hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                title={cleanTitle(file.title)}
                onClick={() => onSelect(file)}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
                <span className="shrink-0 rounded-full px-1.5 text-[9px]" style={badge.style}>{badge.label}</span>
                {verdict ? <span className="shrink-0 text-[10px] text-dim" aria-hidden>{verdict}</span> : null}
                <span className="truncate">{cleanTitle(file.title, 60)}</span>
                <span className="shrink-0 font-normal text-dim">{fmtAge(file.mtime)}</span>
              </button>
            );
          })}
        </FlipRow>
      ) : null}
    </div>
  );
}

/**
 * Board strip of worker-class conversations that have auto-collapsed (issue
 * #112): finished reviewer rounds, quiet flow implementers, pipeline stages and
 * agent-spawned subtasks, grouped into a compact per-flow / per-worktree stack.
 * Each stack expands on click; opening a member routes through the board's
 * normal open (which pins it as a manual placement, so a hand-expanded card
 * survives reloads and never re-collapses under the owner).
 */
export function WorkerStacks({
  stacks,
  files,
  flows,
  onSelect,
}: {
  stacks: WorkerStack[];
  files: FileEntry[];
  flows: Flow[];
  onSelect: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const total = useMemo(() => stacks.reduce((sum, stack) => sum + stack.items.length, 0), [stacks]);
  const titleByImplementer = useMemo(() => new Map(files.map((file) => [file.path, file.title] as const)), [files]);
  if (!stacks.length) return null;

  const labelFor = (stack: WorkerStack): string => {
    if (stack.kind === "flow") {
      const flow = flows.find((candidate) => candidate.id === stack.id);
      const implTitle = flow ? titleByImplementer.get(flow.implementerPath) : undefined;
      return cleanTitle(implTitle ?? t("workerStack.flow"), 60);
    }
    return stack.id ? cleanTitle(stack.id, 60) : t("workerStack.worktree");
  };

  return (
    <div className="shrink-0 border-t border-line bg-panel" data-testid="worker-stacks">
      <button
        className="flex h-8 items-center gap-2 px-4 text-[10px] font-bold uppercase tracking-[.6px] text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-expanded={open}
        aria-label={t("workerStack.aria")}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        {t("workerStack.title")}
        <span className="font-semibold normal-case tracking-normal">{total}</span>
      </button>
      {open ? (
        <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto px-3 pb-2.5">
          {stacks.map((stack) => (
            <StackRow key={stack.key} stack={stack} label={labelFor(stack)} flows={flows} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
