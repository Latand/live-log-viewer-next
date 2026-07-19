"use client";

import { useMemo, useState } from "react";

import { ChevronRight, Layers } from "@/components/icons";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { FlipRow } from "./FlipRow";
import { isDirectReviewFlow } from "./flows/directReviewGroups";
import { VERDICT_GLYPHS, verdictTone } from "./flows/flowModel";
import { deckDisclosureTerminal } from "./flows/reviewDeckDisclosure";
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
  reviewGroup,
  onSelect,
  onExpandGroup,
}: {
  stack: WorkerStack;
  label: string;
  flows: readonly Flow[];
  /** Set when this stack IS a terminal direct review group (#289 + #325): the
      row carries the group's final verdict and an expand-group action that
      restores the full deck at the reviewed anchor on the board. */
  reviewGroup: Flow | null;
  onSelect: (file: FileEntry) => void;
  onExpandGroup?: (flow: Flow) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const lastRound = reviewGroup?.rounds[reviewGroup.rounds.length - 1] ?? null;
  const tone = lastRound ? verdictTone(lastRound.verdict) : null;
  return (
    <div className="min-w-0">
      <div className="flex w-full items-center gap-1">
        <button
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2 text-left text-[11px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "min-h-11" : "h-7"
          }`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          <Layers className="h-3 w-3 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {lastRound && tone ? (
            <span
              className="inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-[9.5px] font-bold"
              style={{ backgroundColor: tone.soft, color: tone.color }}
            >
              {lastRound.verdict ? `${VERDICT_GLYPHS[lastRound.verdict]} ${lastRound.verdict}` : t("roundDeck.aborted")}
            </span>
          ) : null}
          <span className="shrink-0 text-[10px] font-normal tabular-nums text-muted">{stack.items.length}</span>
        </button>
        {reviewGroup && onExpandGroup ? (
          <button
            type="button"
            data-review-group-expand
            className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border border-border bg-card text-muted shadow-1 hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              isMobile ? "min-h-11 min-w-11" : "h-7 w-7"
            }`}
            aria-label={t("workerStack.expandGroup")}
            title={t("workerStack.expandGroup")}
            onClick={() => onExpandGroup(reviewGroup)}
          >
            <Layers className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {open ? (
        <FlipRow className="mt-1 flex flex-wrap items-start gap-1.5 pb-1 pl-5">
          {stack.items.map((file) => {
            const badge = engineBadge(file);
            const verdict = reviewerVerdict(file, flows);
            return (
              <button
                key={file.path}
                data-flip-key={file.path}
                className={`inline-flex max-w-[340px] items-center gap-1.5 rounded-full border border-transparent bg-sunken text-[11px] font-semibold text-primary hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isMobile ? "min-h-11 px-3" : "h-7 px-2"
                }`}
                title={cleanTitle(file.title)}
                onClick={() => onSelect(file)}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
                <span className="shrink-0 rounded-full px-1.5 text-[9px]" style={badge.style}>{badge.label}</span>
                {verdict ? <span className="shrink-0 text-[10px] text-muted" aria-hidden>{verdict}</span> : null}
                <span className="truncate">{cleanTitle(file.title, 60)}</span>
                <span className="shrink-0 font-normal text-muted">{fmtAge(file.mtime)}</span>
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
 * survives reloads and never re-collapses under the owner). A stack that is a
 * terminal direct review group carries the group's final verdict chip and an
 * expand-group action (#289 + #325) that restores the whole deck on the board.
 */
export function WorkerStacks({
  stacks,
  files,
  flows,
  pipelines = [],
  onSelect,
  onExpandGroup,
}: {
  stacks: WorkerStack[];
  files: FileEntry[];
  flows: Flow[];
  /** Pipelines, for naming a per-pipeline origin stack by its task (issue #136). */
  pipelines?: Pipeline[];
  onSelect: (file: FileEntry) => void;
  /** Expands a terminal direct review group back onto the board. */
  onExpandGroup?: (flow: Flow) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const total = useMemo(() => stacks.reduce((sum, stack) => sum + stack.items.length, 0), [stacks]);
  const titleByPath = useMemo(() => new Map(files.map((file) => [file.path, file.title] as const)), [files]);
  if (!stacks.length) return null;

  const labelFor = (stack: WorkerStack): string => {
    if (stack.kind === "flow") {
      const flow = flows.find((candidate) => candidate.id === stack.id);
      const implTitle = flow ? titleByPath.get(flow.implementerPath) : undefined;
      return cleanTitle(implTitle ?? t("workerStack.flow"), 60);
    }
    if (stack.kind === "pipeline") {
      const pipeline = pipelines.find((candidate) => candidate.id === stack.id);
      return cleanTitle(pipeline?.task ?? t("workerStack.pipeline"), 60);
    }
    if (stack.kind === "origin") {
      /* A spawner group: the root-ancestor conversation's own title names it. */
      return cleanTitle(titleByPath.get(stack.id) ?? t("workerStack.origin"), 60);
    }
    return stack.id ? cleanTitle(stack.id, 60) : t("workerStack.worktree");
  };

  const reviewGroupFor = (stack: WorkerStack): Flow | null => {
    if (stack.kind !== "flow") return null;
    const flow = flows.find((candidate) => candidate.id === stack.id);
    if (!flow || !isDirectReviewFlow(flow) || !deckDisclosureTerminal(flow)) return null;
    return flow;
  };

  return (
    <div className="shrink-0 border-t border-border bg-canvas" data-testid="worker-stacks">
      <SectionHeader
        open={open}
        onToggle={() => setOpen((value) => !value)}
        label={t("workerStack.title")}
        count={total}
        ariaLabel={t("workerStack.aria")}
        mobile={isMobile}
      />
      {open ? (
        <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto px-3 pb-2.5">
          {stacks.map((stack) => (
            <StackRow
              key={stack.key}
              stack={stack}
              label={labelFor(stack)}
              flows={flows}
              reviewGroup={reviewGroupFor(stack)}
              onSelect={onSelect}
              onExpandGroup={onExpandGroup}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
