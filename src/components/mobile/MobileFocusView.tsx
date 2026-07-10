"use client";

import { ListTodo } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2, X } from "@/components/icons";
import { TaskSheet, type TaskSheetView } from "@/components/tasks/TaskSheet";
import { viewBus } from "@/hooks/viewPresenceBus";
import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";

import { BranchPane } from "@/components/BranchPane";
import { DraftAgentPane } from "@/components/DraftAgentPane";
import { isWorkflowDraftId } from "@/components/workflows/workflowModel";
import { WorkflowDraftPane } from "@/components/workflows/WorkflowDraftPane";
import { RoundDeck } from "@/components/flows/RoundDeck";
import { canHandoff, HandoffHandle } from "@/components/HandoffHandle";
import { paneState, type PaneState } from "@/components/paneState";
import type { BranchGroup } from "@/components/projectModel";
import { activityDot, cleanTitle, engineBadge, engineColor } from "@/components/utils";

import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { SchemeBoard } from "@/components/scheme/SchemeBoard";
import { TASK_W, taskCardHeight } from "@/components/scheme/taskGeometry";
import { TASK_TONES } from "@/components/tasks/taskModel";

const focusKey = (project: string) => "llvFocus:" + project;

/* Attention-first default: the conversation whose move it is beats a running
   one, freshness breaks ties inside a class. */
const STATE_SCORE: Record<PaneState, number> = { waiting: 5, stalled: 4, live: 3, returned: 2, done: 1 };

/* Swipe on the pane header: mostly-horizontal and long enough to be deliberate. */
const SWIPE_MIN_X = 56;

interface Entry {
  key: string;
  file: FileEntry | null;
  isRoot: boolean;
  kind: "node" | "draft" | "deck";
}

interface Props {
  project: string;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  /** This project's board tasks: mini-cards on the map, editable in the sheet. */
  tasks: BoardTask[];
  /** Ids of not-yet-spawned conversation drafts, focusable like nodes. */
  drafts: string[];
  loaded: boolean;
  /** Path an opener wants on screen (same signal the scheme camera gets). */
  focus: string | null;
  onSelect: (file: FileEntry) => void;
  onClose: (path: string) => void;
  onDraftClose: (id: string) => void;
  onDraftSpawned: (id: string, file: FileEntry) => void;
  onHandoff?: (file: FileEntry) => void;
}

/**
 * The phone presentation of a project: one conversation pinned nearly
 * full-screen, a strip of status chips to hop between conversations, a
 * minimap chip that unfolds the whole scheme as a pick-only map. The same
 * data the scheme draws — nothing on the diagram is unreachable, it is just
 * shown one pane at a time.
 */
export function MobileFocusView({ project, groups, manual, files, flows, tasks, drafts, loaded, focus, onSelect, onClose, onDraftClose, onDraftSpawned, onHandoff }: Props) {
  const { t } = useLocale();
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [taskSheet, setTaskSheet] = useState<TaskSheetView | null>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const activeChipRef = useRef<HTMLButtonElement | null>(null);

  const layout = useMemo(() => buildSchemeLayout(groups, manual, files, flows, drafts), [groups, manual, files, flows, drafts]);
  /* Scheme order (depth-first, groups left to right) becomes the strip order,
     so chips and the map agree on what "next" means. */
  const entries = useMemo<Entry[]>(
    () => [
      ...layout.nodes.map((node) => ({ key: node.file.path, file: node.file, isRoot: node.isRoot, kind: "node" as const })),
      ...layout.decks.map((deck) => ({ key: deck.key, file: null, isRoot: false, kind: "deck" as const })),
      ...layout.drafts.map((draft) => ({ key: draft.key, file: null, isRoot: true, kind: "draft" as const })),
    ],
    [layout],
  );
  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setFocusPath(sessionStorage.getItem(focusKey(project)));
    setMapOpen(false);
  }, [project]);

  /* Any open (overview card, toast, switch of a quiet branch) arrives as the
     transient highlight: pin it and drop the map. */
  useEffect(() => {
    if (!focus) return;
    setFocusPath(focus);
    setMapOpen(false);
  }, [focus]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* The pinned key while it exists; otherwise the most attention-worthy node,
     so a closed pane falls through to the next thing that matters. */
  const resolvedKey = useMemo(() => {
    if (focusPath && byKey.has(focusPath)) return focusPath;
    let best: Entry | null = null;
    let bestScore = -1;
    for (const entry of entries) {
      if (!entry.file) continue;
      const score = STATE_SCORE[paneState(entry.file)] * 1e12 + entry.file.mtime;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return (best ?? entries[0])?.key ?? null;
  }, [focusPath, byKey, entries]);

  useEffect(() => {
    if (focusPath && byKey.has(focusPath)) {
      sessionStorage.setItem(focusKey(project), focusPath);
    } else if (!focusPath && resolvedKey) {
      sessionStorage.setItem(focusKey(project), resolvedKey);
    }
  }, [focusPath, byKey, resolvedKey, project]);

  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [resolvedKey]);

  const activeNode = useMemo(() => layout.nodes.find((node) => node.file.path === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeDeck = useMemo(() => layout.decks.find((deck) => deck.key === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeDraft = useMemo(() => layout.drafts.find((draft) => draft.key === resolvedKey) ?? null, [layout, resolvedKey]);

  /* Presence: the phone reports the pinned pane as the sole visible transcript
     (a deck/draft carries no transcript path, so focus is null there); opening
     the map switches to mobile-map and reports the whole board in layout order.
     The nested map camera is not surfaced to observers in this MVP. */
  useEffect(() => {
    const focusedPath = activeNode ? activeNode.file.path : null;
    const visiblePaths = mapOpen
      ? layout.nodes.slice(0, MAX_VISIBLE_PATHS).map((node) => node.file.path)
      : activeNode
        ? [activeNode.file.path]
        : [];
    viewBus.reportSlice({ mode: mapOpen ? "mobile-map" : "mobile-focus", focusedPath, selectedPaths: [], visiblePaths, camera: null });
  }, [activeNode, mapOpen, layout]);

  const step = useCallback(
    (dir: number) => {
      if (!entries.length) return;
      const idx = entries.findIndex((entry) => entry.key === resolvedKey);
      const next = entries[Math.min(entries.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + dir))];
      if (next && next.key !== resolvedKey) setFocusPath(next.key);
    },
    [entries, resolvedKey],
  );

  /* Rides the pane header via BranchPane's dragHandle slot: the feed below
     keeps its native scroll, only the header answers to swipes. */
  const swipeHandle = {
    onTouchStart: (event: React.TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      if (touch) swipeRef.current = { x: touch.clientX, y: touch.clientY };
    },
    onTouchEnd: (event: React.TouchEvent<HTMLElement>) => {
      const start = swipeRef.current;
      swipeRef.current = null;
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 2) return;
      step(dx < 0 ? 1 : -1);
    },
  };

  /* A map tap on a scheme node pins it; a quiet branch or deck round is not a
     node yet — route it through onSelect so it becomes one and focuses via
     the highlight round-trip. */
  const pickFromMap = useCallback(
    (key: string) => {
      setMapOpen(false);
      /* Task mini-cards on the map open in the sheet, not as panes. */
      if (key.startsWith("task::")) {
        setTaskSheet({ taskId: key.slice("task::".length) });
        return;
      }
      if (byKey.has(key)) {
        setFocusPath(key);
        return;
      }
      const file = files.find((entry) => entry.path === key);
      if (file) onSelect(file);
    },
    [byKey, files, onSelect],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {entries.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-panel px-2 py-1.5">
          {entries.map((entry) => (
            <StripChip
              key={entry.key}
              entry={entry}
              active={entry.key === resolvedKey}
              chipRef={entry.key === resolvedKey ? activeChipRef : undefined}
              onClick={() => setFocusPath(entry.key)}
            />
          ))}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {activeNode ? (
          <div key={activeNode.file.path} className="relative flex min-h-0 flex-1">
            <BranchPane
              file={activeNode.file}
              tasks={activeNode.tasks}
              isRoot={activeNode.isRoot}
              onClose={() => onClose(activeNode.file.path)}
              dragHandle={swipeHandle}
            />
            {onHandoff && canHandoff(activeNode.file) ? <HandoffHandle file={activeNode.file} onHandoff={() => onHandoff(activeNode.file)} /> : null}
          </div>
        ) : activeDeck ? (
          <div key={activeDeck.key} className="relative min-h-0 flex-1">
            <RoundDeck flow={activeDeck.flow} rounds={activeDeck.rounds} focusRound={null} />
          </div>
        ) : activeDraft ? (
          isWorkflowDraftId(activeDraft.id) ? (
            <WorkflowDraftPane
              key={activeDraft.key}
              draftId={activeDraft.id}
              project={project}
              onClose={() => onDraftClose(activeDraft.id)}
              onLaunched={() => onDraftClose(activeDraft.id)}
            />
          ) : (
            <DraftAgentPane
              key={activeDraft.key}
              draftId={activeDraft.id}
              project={project}
              files={files}
              onClose={() => onDraftClose(activeDraft.id)}
              onSpawned={(file) => onDraftSpawned(activeDraft.id, file)}
            />
          )
        ) : loaded ? (
          <div className="flex flex-1 items-center justify-center text-center text-[13px] text-dim">{t("mobile.noConvos")}</div>
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-center text-[13px] text-dim">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("common.loading")}
          </div>
        )}
        <MapChip layout={layout} tasks={tasks} current={resolvedKey} onOpen={() => setMapOpen(true)} />
        <button
          type="button"
          className="absolute bottom-[168px] right-4 z-30 inline-flex h-9 items-center gap-1 rounded-full border border-line bg-panel/95 px-2.5 text-[11px] font-bold text-ink shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("tasks.panelToggleAria")}
          onClick={() => setTaskSheet("list")}
        >
          <ListTodo className="h-4 w-4 text-accent" aria-hidden />
          {tasks.filter((task) => task.status !== "done").length || null}
        </button>
      </div>

      {mapOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg pb-[env(safe-area-inset-bottom)]">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
            <span className="shrink-0 text-[13px] font-bold">{t("mobile.map")}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{project}</span>
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("mobile.closeMap")}
              onClick={() => setMapOpen(false)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <SchemeBoard
            project={project}
            groups={groups}
            manual={manual}
            files={files}
            flows={flows}
            tasks={tasks}
            drafts={drafts}
            focus={null}
            ring={resolvedKey}
            onSelect={onSelect}
            onClose={onClose}
            onDraftClose={onDraftClose}
            onDraftSpawned={onDraftSpawned}
            onNodePick={pickFromMap}
          />
          <div className="shrink-0 border-t border-line bg-panel px-3 py-1.5 text-center text-[11px] text-dim">
            {t("mobile.tapNode")}
          </div>
        </div>
      ) : null}

      {taskSheet ? (
        <TaskSheet project={project} tasks={tasks} files={files} initialView={taskSheet} onClose={() => setTaskSheet(null)} />
      ) : null}
    </div>
  );
}

/** One conversation in the switch strip: dot + engine label, the active one
    carries its title. Waiting conversations keep their amber tone visible. */
function StripChip({
  entry,
  active,
  chipRef,
  onClick,
}: {
  entry: Entry;
  active: boolean;
  chipRef?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  const { t } = useLocale();
  if (!entry.file) {
    const deck = entry.kind === "deck";
    return (
      <button
        ref={chipRef}
        type="button"
        className={`flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold ${
          active ? "border-accent/60 bg-accent/10 text-ink" : "border-dashed border-line bg-bg text-dim"
        }`}
        onClick={onClick}
      >
        <span className="text-[13px] leading-none text-accent">{deck ? "R" : "＋"}</span> {deck ? t("scheme.flow") : t("mobile.agent")}
      </button>
    );
  }
  const file = entry.file;
  const state = paneState(file);
  const waiting = state === "waiting" || state === "stalled";
  const badge = engineBadge(file);
  const title = cleanTitle(file.title, 60);
  return (
    <button
      ref={chipRef}
      type="button"
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold ${
        active
          ? "border-accent/60 bg-accent/10 text-ink"
          : waiting
            ? "border-[#e0ae45]/60 bg-[#fff7e6] text-[#8a5a00]"
            : "border-line bg-bg text-dim"
      }`}
      title={title}
      onClick={onClick}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
      {entry.isRoot ? null : <span aria-hidden>⤷</span>}
      {active ? <span className="max-w-[52vw] truncate">{title}</span> : <span>{waiting ? "⏸ " : ""}{badge.label}</span>}
    </button>
  );
}

const CHIP_W = 96;
const CHIP_H = 64;

/** Live thumbnail of the whole scheme floating over the focused pane: every
    node as an engine-colored block, the pinned one framed. A tap unfolds the
    full map. */
function MapChip({
  layout,
  tasks,
  current,
  onOpen,
}: {
  layout: SchemeLayout;
  tasks: BoardTask[];
  current: string | null;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const scale = Math.min(CHIP_W / layout.width, CHIP_H / layout.height);
  const ox = (CHIP_W - layout.width * scale) / 2;
  const oy = (CHIP_H - layout.height * scale) / 2;
  return (
    <button
      type="button"
      className="absolute bottom-[92px] right-4 z-30 overflow-hidden rounded-[10px] border border-line bg-panel/95 shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      style={{ width: CHIP_W, height: CHIP_H }}
      aria-label={t("mobile.openMap")}
      onClick={onOpen}
    >
      <svg width={CHIP_W} height={CHIP_H} aria-hidden>
        <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
          {layout.stacks.map((stack) => (
            <rect key={stack.key} x={stack.x} y={stack.y} width={stack.w} height={stack.h} rx={24} fill="#c9c9d1" opacity={0.45} />
          ))}
          {layout.drafts.map((draft) => (
            <rect
              key={draft.key}
              x={draft.x}
              y={draft.y}
              width={draft.w}
              height={draft.h}
              rx={24}
              fill="#9a9aa4"
              opacity={0.3}
              stroke={draft.key === current ? "#5a51e0" : undefined}
              strokeWidth={draft.key === current ? 5 / scale : undefined}
            />
          ))}
          {layout.decks.map((deck) => (
            <rect
              key={deck.key}
              x={deck.x}
              y={deck.y}
              width={deck.w}
              height={deck.h}
              rx={24}
              fill="#5a51e0"
              opacity={0.35}
              stroke={deck.key === current ? "#5a51e0" : undefined}
              strokeWidth={deck.key === current ? 5 / scale : undefined}
            />
          ))}
          {layout.nodes.map((node) => (
            <rect
              key={node.file.path}
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              rx={24}
              fill={engineColor(node.file)}
              opacity={node.file.activity === "live" ? 0.85 : 0.35}
              stroke={node.file.path === current ? "#5a51e0" : undefined}
              strokeWidth={node.file.path === current ? 5 / scale : undefined}
            />
          ))}
          {tasks.map((task) => (
            <circle
              key={task.id}
              cx={task.pos.x + TASK_W / 2}
              cy={task.pos.y + taskCardHeight(task) / 2}
              r={3 / scale}
              fill={TASK_TONES[task.status].color}
              opacity={task.status === "done" ? 0.5 : 0.95}
            />
          ))}
        </g>
      </svg>
    </button>
  );
}
