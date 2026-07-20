"use client";

import { useMemo, useState } from "react";

import { KanbanSquare } from "lucide-react";

import { SectionHeader } from "@/components/ui/SectionHeader";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import { latestOperationalPipelineAttempt } from "@/lib/pipelines/attemptSelection";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { FlipRow } from "./FlipRow";
import { assignmentAgentState, assignmentOpenable } from "./scheme/assignmentState";
import { TASK_TONES, taskTitle } from "./tasks/taskModel";
import {
  READINESS_TONES,
  buildReadinessIndex,
  issueRefs,
  partitionReadiness,
  taskLinks,
  type ReadinessIndex,
  type ReadinessSection,
} from "./tasks/taskReadiness";
import { cleanTitle } from "./utils";

/** One-word activity decoration derived from the task's assignments. Purely
    cosmetic — the readiness section never moves with liveness (issue #290). */
function assignmentDecoration(task: BoardTask, byPath: ReadonlyMap<string, FileEntry>): "failed" | "gone" | "live" | null {
  let gone = false;
  let live = false;
  for (const assignment of task.assignments) {
    const state = assignmentAgentState(assignment, assignment.path ? byPath.get(assignment.path) ?? null : null);
    if (state === "failed") return "failed";
    if (state === "gone") gone = true;
    if (state === "live") live = true;
  }
  return live ? "live" : gone ? "gone" : null;
}

function TaskChip({
  task,
  index,
  byPath,
  repository,
  onOpenTask,
  onPlaceOnMap,
  onOpenFile,
}: {
  task: BoardTask;
  index: ReadinessIndex;
  byPath: ReadonlyMap<string, FileEntry>;
  repository?: string | null;
  onOpenTask: (task: BoardTask) => void;
  onPlaceOnMap?: (task: BoardTask) => void;
  onOpenFile: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const title = cleanTitle(taskTitle(task.text), 60) || t("tasks.untitled");
  const unplaced = task.placement === "unplaced" || !task.pos;
  const tone = TASK_TONES[task.status];
  const decoration = assignmentDecoration(task, byPath);
  const issues = issueRefs(task.text);
  const links = taskLinks(task, index);
  /* One navigation chip per linked container: the pipeline's latest operational
     attempt transcript / the flow's latest reviewer (implementer fallback),
     resolved against the current scan — a vanished worktree drops the chip. */
  const pipelineFile = links.pipelines
    .map((pipeline) => latestOperationalPipelineAttempt(pipeline))
    .map((attempt) => (attempt?.agentPath ? byPath.get(attempt.agentPath) : undefined))
    .filter((file): file is FileEntry => file !== undefined)
    .at(-1);
  const reviewFile = links.flows
    .flatMap((flow) => [flow.implementerPath, ...flow.rounds.map((round) => round.reviewerPath)])
    .map((pathname) => (pathname ? byPath.get(pathname) : undefined))
    .filter((file): file is FileEntry => file !== undefined)
    .at(-1);
  const agentFile = task.assignments
    .map((assignment) => (assignment.path ? byPath.get(assignment.path) ?? null : null))
    .find((file, position) => {
      const assignment = task.assignments[position]!;
      return file !== null && assignmentOpenable(assignmentAgentState(assignment, file));
    });
  const tap = isMobile ? "min-h-11 px-2" : "h-6 px-1.5";
  const linkChip = `inline-flex items-center rounded-full bg-card text-[10px] font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tap}`;
  return (
    <div
      data-flip-key={task.id}
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1 rounded-[10px] border border-transparent px-1 py-0.5"
      style={{ backgroundColor: tone.soft }}
    >
      <button
        className={`inline-flex min-w-0 max-w-[300px] items-center gap-1.5 rounded-full text-[11px] font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tap}`}
        title={t(unplaced && onPlaceOnMap ? "readiness.place" : "readiness.open", { title })}
        aria-label={t(unplaced && onPlaceOnMap ? "readiness.place" : "readiness.open", { title })}
        onClick={() => (unplaced && onPlaceOnMap ? onPlaceOnMap(task) : onOpenTask(task))}
      >
        <span className="truncate">{title}</span>
      </button>
      <span className="shrink-0 rounded-full bg-card px-1.5 text-[9px] font-bold" style={{ color: tone.color }}>
        {t(`tasks.status.${task.status}`)}
      </span>
      {decoration ? (
        <span
          className={`shrink-0 rounded-full bg-card px-1.5 text-[9px] font-bold ${decoration === "failed" ? "text-danger" : decoration === "live" ? "text-success" : "text-muted"}`}
          title={t(`readiness.state.${decoration}`)}
        >
          {decoration === "failed" ? "⚠ " : ""}
          {t(`readiness.state.${decoration}`)}
        </span>
      ) : null}
      {issues.map((issue) =>
        repository ? (
          <a
            key={issue}
            className={linkChip}
            href={`https://github.com/${repository}/issues/${issue}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t("readiness.issueAria", { issue })}
          >
            #{issue}
          </a>
        ) : (
          <span key={issue} className={`inline-flex items-center rounded-full bg-card text-[10px] font-semibold text-secondary ${tap}`}>
            #{issue}
          </span>
        ),
      )}
      {agentFile ? (
        <button className={linkChip} aria-label={t("readiness.agentAria", { title })} onClick={() => onOpenFile(agentFile)}>
          {t("readiness.agent")}
        </button>
      ) : null}
      {pipelineFile ? (
        <button className={linkChip} aria-label={t("readiness.pipelineAria", { title })} onClick={() => onOpenFile(pipelineFile)}>
          {t("readiness.pipeline")}
        </button>
      ) : null}
      {reviewFile && reviewFile !== agentFile ? (
        <button className={linkChip} aria-label={t("readiness.reviewAria", { title })} onClick={() => onOpenFile(reviewFile)}>
          {t("readiness.review")}
        </button>
      ) : null}
    </div>
  );
}

function ReadinessRow({
  section,
  index,
  byPath,
  repository,
  onOpenTask,
  onPlaceOnMap,
  onOpenFile,
}: {
  section: ReadinessSection;
  index: ReadinessIndex;
  byPath: ReadonlyMap<string, FileEntry>;
  repository?: string | null;
  onOpenTask: (task: BoardTask) => void;
  onPlaceOnMap?: (task: BoardTask) => void;
  onOpenFile: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const tone = READINESS_TONES[section.readiness];
  const heading = t(`readiness.section.${section.readiness}`);
  return (
    <div className="min-w-0" data-readiness-section={section.readiness}>
      <button
        className={`flex w-full items-center gap-2 rounded-[8px] px-2 text-left text-[11px] font-semibold text-primary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isMobile ? "min-h-11" : "h-7"
        }`}
        aria-expanded={open}
        aria-label={t("readiness.sectionAria", { section: heading, count: section.items.length })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tone.color }} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{heading}</span>
        <span className="shrink-0 text-[10px] font-normal tabular-nums text-muted">{section.items.length}</span>
      </button>
      {open && section.items.length ? (
        <FlipRow className="mt-1 flex min-w-0 flex-wrap items-start gap-1.5 pb-1 pl-5">
          {section.items.map((task) => (
            <TaskChip
              key={task.id}
              task={task}
              index={index}
              byPath={byPath}
              repository={repository}
              onOpenTask={onOpenTask}
              onPlaceOnMap={onPlaceOnMap}
              onOpenFile={onOpenFile}
            />
          ))}
        </FlipRow>
      ) : null}
    </div>
  );
}

/**
 * Readiness Kanban strip (issue #290): every task of the selected project —
 * placed, unplaced, stacked or full-size — folds into exactly one of five
 * compact readiness sections (Now / Ready for review / Blocked / Planned /
 * Done). Sections derive from durable state only (task status, assignment
 * states, linked pipeline/flow states and persisted verdicts), so the counts
 * are identical across reload, restart, alias remap and deleted worktrees.
 * Chips link back to the task card, its agents, pipelines, reviews and GitHub
 * issues; nothing here mutates or deletes task history.
 */
export function TaskReadinessStrip({
  tasks,
  files,
  pipelines,
  flows,
  conversationAliases,
  repository,
  onOpenTask,
  onPlaceOnMap,
  onOpenFile,
}: {
  tasks: BoardTask[];
  files: FileEntry[];
  pipelines: Pipeline[];
  flows: Flow[];
  conversationAliases?: Record<string, string>;
  /** GitHub `owner/repo` of the project root; absent renders issue refs as plain text. */
  repository?: string | null;
  onOpenTask: (task: BoardTask) => void;
  /** Desktop place-on-map for unplaced cards; absent routes them to onOpenTask. */
  onPlaceOnMap?: (task: BoardTask) => void;
  onOpenFile: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const index = useMemo(() => buildReadinessIndex(pipelines, flows, conversationAliases), [pipelines, flows, conversationAliases]);
  const sections = useMemo(() => partitionReadiness(tasks, index), [tasks, index]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);
  if (!tasks.length) return null;
  return (
    <div className="shrink-0 border-t border-border bg-canvas" data-testid="task-readiness">
      <SectionHeader
        open={open}
        onToggle={() => setOpen((value) => !value)}
        label={t("readiness.title")}
        count={tasks.length}
        icon={<KanbanSquare className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
        ariaLabel={t("readiness.aria")}
        mobile={isMobile}
      />
      {open ? (
        <div className={`flex flex-col gap-0.5 overflow-y-auto px-3 pb-2.5 ${isMobile ? "max-h-96" : "max-h-64"}`}>
          <p role="note" className="px-2 pb-1 text-[10px] leading-snug text-muted">
            {t("readiness.legend")}
          </p>
          {sections.map((section) => (
            <ReadinessRow
              key={section.readiness}
              section={section}
              index={index}
              byPath={byPath}
              repository={repository}
              onOpenTask={onOpenTask}
              onPlaceOnMap={onPlaceOnMap}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
