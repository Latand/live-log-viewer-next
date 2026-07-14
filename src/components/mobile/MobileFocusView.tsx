"use client";

import { ListTodo, Map as MapIcon, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2, X } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { TaskSheet, type TaskSheetView } from "@/components/tasks/TaskSheet";
import { viewBus } from "@/hooks/viewPresenceBus";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineAction } from "@/lib/pipelines/types";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";

import { BranchPane } from "@/components/BranchPane";
import { ConnectionPill } from "@/components/ConnectionPill";
import { DraftAgentPane } from "@/components/DraftAgentPane";
import { isWorkflowDraftId } from "@/components/workflows/workflowModel";
import { WorkflowDraftPane } from "@/components/workflows/WorkflowDraftPane";
import { RoundDeck } from "@/components/flows/RoundDeck";
import { mapReachable } from "./mapGate";
import { paneState, type PaneState } from "@/components/paneState";
import type { BranchGroup } from "@/components/projectModel";
import { activityDot, cleanTitle, engineBadge } from "@/components/utils";

import { PIPELINE_ATTENTION_STATES, PIPELINE_BUSY_STATES, STAGE_GLYPH, STAGE_TONES, latestAttempt, patchPipeline, pipelineStateLabel, renderableFlowIds, stageChipLabel, stageChipState, stageHasEvidence, stageOpenTarget } from "@/components/pipelines/pipelineModel";
import { VerdictPopover } from "@/components/pipelines/VerdictPopover";
import { deckKey } from "@/components/scheme/agentLinks";
import { buildSchemeLayout, type SchemeGroup } from "@/components/scheme/layout";
import { SchemeBoard } from "@/components/scheme/SchemeBoard";
import type { WorkerStack } from "@/components/scheme/workerCollapse";

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
  pipelines: Pipeline[];
  /** Active project pipelines needing a scheme surface with no placed stage node
      yet (issue #136): docked as placeholder groups in the map layout. */
  surfacePipelines?: Pipeline[];
  /** Collapsed worker stacks (issue #136): one dot per origin on the full-map
      minimap, so folded workers read as a handful of dots there too. */
  workerStacks?: WorkerStack[];
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
  /** Reports the focused conversation's file (or null) so the project shell can
      dock a single handoff control in the footer shelf row (issue #177 item 5),
      keeping the handoff, collapsed-worker, and quiet strips on one row. */
  onActiveChange?: (file: FileEntry | null) => void;
  /** Bumped by the header `+ Task` button to open the sheet's create view. */
  taskSheetNonce?: number;
}

/**
 * Every active pipeline that gets a full-plan dock card on the phone (issue
 * #156): both memberless placeholder groups (no board node — issue #136) and
 * memberful pipelines, whose complete stage plan the mobile lite map never
 * paints. One card per pipeline group, so no active pipeline is left with only
 * the three-stage hop window and no complete plan.
 */
export function pipelinesToDock(groups: SchemeGroup[]): Pipeline[] {
  return groups.flatMap((group) => (group.pipeline ? [group.pipeline] : []));
}

/**
 * The phone presentation of a project: one conversation pinned nearly
 * full-screen, a strip of status chips to hop between conversations, a
 * minimap chip that unfolds the whole scheme as a pick-only map. The same
 * data the scheme draws — nothing on the diagram is unreachable, it is just
 * shown one pane at a time.
 */
export function MobileFocusView({ project, groups, manual, files, flows, pipelines, surfacePipelines = [], workerStacks = [], tasks, drafts, loaded, focus, onSelect, onClose, onDraftClose, onDraftSpawned, onActiveChange, taskSheetNonce = 0 }: Props) {
  const { t } = useLocale();
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [taskSheet, setTaskSheet] = useState<TaskSheetView | null>(null);
  /* The header `+ Task` button opens the create view; the first render's nonce
     of 0 never triggers it. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- opens the sheet once per `+ Task` press */
    if (taskSheetNonce > 0) setTaskSheet("new");
  }, [taskSheetNonce]);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const activeChipRef = useRef<HTMLButtonElement | null>(null);
  /* Fade hints on the chip strip: which clipped edge still has content to reveal. */
  const chipScrollRef = useRef<HTMLDivElement | null>(null);
  const [chipFade, setChipFade] = useState({ left: false, right: false });
  const syncChipFade = useCallback(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setChipFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  const layout = useMemo(() => buildSchemeLayout(groups, manual, files, flows, drafts, pipelines, surfacePipelines), [groups, manual, files, flows, drafts, pipelines, surfacePipelines]);
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
    syncChipFade();
  }, [resolvedKey, entries, syncChipFade]);

  const activeNode = useMemo(() => layout.nodes.find((node) => node.file.path === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeDeck = useMemo(() => layout.decks.find((deck) => deck.key === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeDraft = useMemo(() => layout.drafts.find((draft) => draft.key === resolvedKey) ?? null, [layout, resolvedKey]);
  /* Report the focused conversation up so the project shell can dock its handoff
     control in the footer shelf row (issue #177 item 5). Cleared on unmount so a
     switch to the list view drops the stale handoff target. */
  useEffect(() => {
    onActiveChange?.(activeNode?.file ?? null);
  }, [activeNode, onActiveChange]);
  useEffect(() => () => onActiveChange?.(null), [onActiveChange]);
  /* EVERY active pipeline gets a dedicated 44px full-plan/control card on the
     phone (issue #156, HIGH). The mobile lite map passes no pipelineControls, so
     GroupsLayer never paints the past/current/future strip there; a memberful
     pipeline (placed stage nodes) would otherwise expose only the three-stage
     hop window (PipelineFocusRow) and never its complete plan. Docking all
     pipeline groups — memberless placeholders included (issue #136) — makes the
     dock the single full-plan surface for both, with no reliance on the map. */
  const dockedPipelines = useMemo(() => pipelinesToDock(layout.groups), [layout]);

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

  /* When the focused pane is a pipeline stage, a compact chain row rides above
     it: position, current stage/state, and prev/next stage chips to hop along
     the chain (#93 §2.3). A review-loop stage is represented on the board by its
     round deck, so match the focused deck's flow too — otherwise focusing a
     reviewer session would hide the row entirely. */
  const activePath = activeNode ? activeNode.file.path : null;
  const activeFlowId = activeDeck ? activeDeck.flow.id : null;
  const pipelineFocus = findPipelineStage(pipelines, activePath, activeFlowId);
  /* Run transcripts still in the scan can be opened; a review-loop only if its
     flow has a rendered deck, which exists only for a placed implementer node —
     so the availability set comes from the layout's placed nodes. */
  const renderablePaths = useMemo(() => new Set(files.map((entry) => entry.path)), [files]);
  const renderableFlows = useMemo(() => renderableFlowIds(flows, new Set(layout.nodes.map((node) => node.file.path))), [flows, layout]);

  const openStagePath = useCallback(
    (path: string) => {
      const file = files.find((entry) => entry.path === path);
      if (file) onSelect(file);
    },
    [files, onSelect],
  );

  const hopToStage = (index: number) => {
    if (!pipelineFocus) return;
    const stage = pipelineFocus.pipeline.stages[index];
    if (!stage) return;
    const target = stageOpenTarget(stage, latestAttempt(pipelineFocus.pipeline, stage.id), renderableFlows, renderablePaths);
    if (!target) return;
    /* Review-loop targets land on the flow's round deck (an entry key), since the
       reviewer transcript is folded away; run stages open their own node by path. */
    if (target.kind === "flow") {
      const key = deckKey(target.flowId);
      if (byKey.has(key)) setFocusPath(key);
      return;
    }
    openStagePath(target.path);
  };

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
      {/* Same runtime connection pill as desktop, compact, one thumb away.
          Renders nothing while slice-one is disabled. */}
      <ConnectionPill compact />
      {/* One docked navigation strip, two rows total (findings 4, 7): the pipeline
          chain hop chips (when a stage is focused) and the conversation chips share
          this single scrolling row with a fade hint at the clipped edge (finding
          5); the map + tasks controls dock on the right so they never float over
          the transcript (findings 2, 3). No separate third pipeline row. */}
      <div className="flex shrink-0 items-stretch border-b border-border bg-card">
        {entries.length > 1 || pipelineFocus ? (
          <div className="relative min-w-0 flex-1">
            <div ref={chipScrollRef} onScroll={syncChipFade} className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-2 py-1.5">
              {pipelineFocus ? (
                <>
                  <PipelineFocusRow pipeline={pipelineFocus.pipeline} index={pipelineFocus.index} renderableFlows={renderableFlows} renderablePaths={renderablePaths} onHop={hopToStage} onOpenPath={openStagePath} />
                  {entries.length > 1 ? <span aria-hidden className="mx-0.5 h-7 w-px shrink-0 bg-border" /> : null}
                </>
              ) : null}
              {entries.length > 1
                ? entries.map((entry) => (
                    <StripChip
                      key={entry.key}
                      entry={entry}
                      active={entry.key === resolvedKey}
                      chipRef={entry.key === resolvedKey ? activeChipRef : undefined}
                      onClick={() => setFocusPath(entry.key)}
                    />
                  ))
                : null}
            </div>
            {/* Scroll affordance: a soft panel-colored fade over each clipped
                edge, shown only while there is more to scroll that way. */}
            <span aria-hidden className={`pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-card to-transparent transition-opacity ${chipFade.left ? "opacity-100" : "opacity-0"}`} />
            <span aria-hidden className={`pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-card to-transparent transition-opacity ${chipFade.right ? "opacity-100" : "opacity-0"}`} />
          </div>
        ) : (
          <span className="min-w-0 flex-1" aria-hidden />
        )}
        <div className="flex shrink-0 items-center gap-1 border-l border-border px-1.5">
          {/* Collapsed worker stacks count toward map availability (issue #136):
              a worker-heavy board is often one visible root plus several stacks,
              and the map is the only place their per-origin dots can be seen. */}
          {mapReachable(layout.nodes.length, workerStacks.length) ? (
            <button
              type="button"
              className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-[8px] text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("mobile.openMap")}
              onClick={() => setMapOpen(true)}
            >
              <MapIcon className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-[8px] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("tasks.panelToggleAria")}
            onClick={() => setTaskSheet("list")}
          >
            <ListTodo className="h-4 w-4 text-accent" aria-hidden />
            {tasks.filter((task) => task.status !== "done").length ? (
              <span className="rounded-full bg-accent/10 px-1 text-[10px] font-bold text-accent">
                {tasks.filter((task) => task.status !== "done").length}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {/* Even card gutters that also clear the notch/rounded corners (finding 8):
          the safe-area insets keep the pane off the screen edges symmetrically. */}
      <div className="relative flex min-h-0 flex-1 flex-col py-1.5 pl-[max(0.375rem,env(safe-area-inset-left))] pr-[max(0.375rem,env(safe-area-inset-right))] pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {activeNode ? (
          /* The handoff control for this pane docks in the footer shelf row
             (issue #177 item 5), so the focus view itself renders only the pane. */
          <div key={activeNode.file.path} className="flex min-h-0 flex-1">
            <BranchPane
              file={activeNode.file}
              tasks={activeNode.tasks}
              isRoot={activeNode.isRoot}
              showFavorite
              onClose={() => onClose(activeNode.file.path)}
              dragHandle={swipeHandle}
            />
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
          dockedPipelines.length ? (
            /* No conversation yet, but an active pipeline is provisioning: its
               plan + controls ARE the surface here (issue #136 / review). */
            <div className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto">
              {dockedPipelines.map((pipeline) => (
                <MobilePipelineDock key={pipeline.id} pipeline={pipeline} />
              ))}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted">{t("mobile.noConvos")}</div>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-center text-[13px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* When a conversation IS focused, docked pipelines keep a compact
          plan/control bar below the pane so their surface never disappears. */}
      {(activeNode || activeDeck || activeDraft) && dockedPipelines.length ? (
        <div className="max-h-[42vh] shrink-0 divide-y divide-border overflow-y-auto border-t border-border bg-card">
          {dockedPipelines.map((pipeline) => (
            <MobilePipelineDock key={pipeline.id} pipeline={pipeline} />
          ))}
        </div>
      ) : null}

      {mapOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-canvas pb-[env(safe-area-inset-bottom)]">
          <div className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1.5">
            <span className="shrink-0 pl-1 text-[13px] font-bold">{t("mobile.map")}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{project}</span>
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("mobile.closeMap")}
              onClick={() => setMapOpen(false)}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <SchemeBoard
            project={project}
            groups={groups}
            manual={manual}
            files={files}
            flows={flows}
            pipelines={pipelines}
            surfacePipelines={surfacePipelines}
            workerStacks={workerStacks}
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
          {/* The lite map is pick-only and cannot paint a readable stage strip at
              its zoom, so it never surfaces a pipeline's full plan on its own
              (SchemeBoard passes no pipelineControls in map mode). The dock cards
              ride below it here too — otherwise opening the map would hide the
              only full-plan surface for every active pipeline, memberful ones
              included (issue #156). */}
          {dockedPipelines.length ? (
            <div className="max-h-[38vh] shrink-0 divide-y divide-border overflow-y-auto border-t border-border bg-card">
              {dockedPipelines.map((pipeline) => (
                <MobilePipelineDock key={pipeline.id} pipeline={pipeline} />
              ))}
            </div>
          ) : null}
          <div className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-center text-[11px] text-muted">
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

/** The pipeline + stage index a focused transcript path — or a focused round
    deck's flow — belongs to, if any. Review-loop stages match by flow id, since
    the board folds their reviewer transcript into the deck. */
function findPipelineStage(pipelines: Pipeline[], path: string | null, flowId: string | null): { pipeline: Pipeline; index: number } | null {
  if (!path && !flowId) return null;
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed") continue;
    const index = pipeline.stages.findIndex((stage) => {
      const attempt = latestAttempt(pipeline, stage.id);
      if (!attempt) return false;
      if (path && attempt.agentPath === path) return true;
      return Boolean(flowId && attempt.flowId === flowId);
    });
    if (index >= 0) return { pipeline, index };
  }
  return null;
}

/** Compact pipeline chain row over a focused stage pane: position, current
    stage/state, and prev/next stage chips as hop targets along the chain. The
    current-stage chip opens a verdict bottom sheet (#93 §2.3) when its stage has
    run, surfacing findings/confidence and parked Retry/Skip on mobile. */
function PipelineFocusRow({ pipeline, index, renderableFlows, renderablePaths, onHop, onOpenPath }: { pipeline: Pipeline; index: number; renderableFlows: ReadonlySet<string>; renderablePaths: ReadonlySet<string>; onHop: (index: number) => void; onOpenPath: (path: string) => void }) {
  const { t } = useLocale();
  const [sheetOpen, setSheetOpen] = useState(false);
  const total = pipeline.stages.length;
  const stage = pipeline.stages[index]!;
  const state = stageChipState(pipeline, stage);
  const tone = STAGE_TONES[state];
  const prev = index > 0 ? pipeline.stages[index - 1]! : null;
  const next = index < total - 1 ? pipeline.stages[index + 1]! : null;
  /* A hop resolves through stageOpenTarget, so a neighbor is reachable only while
     its flow still has a deck (renderableFlows) or its run transcript is still in
     the scan (renderablePaths). */
  const prevHopEnabled = prev ? Boolean(stageOpenTarget(prev, latestAttempt(pipeline, prev.id), renderableFlows, renderablePaths)) : false;
  const nextHopEnabled = next ? Boolean(stageOpenTarget(next, latestAttempt(pipeline, next.id), renderableFlows, renderablePaths)) : false;
  const attempt = latestAttempt(pipeline, stage.id);
  /* Match the desktop evidence predicate: a running attempt has no verdict sheet
     to open, so the button stays disabled and never shows an empty "no findings". */
  const canOpenVerdict = stageHasEvidence(pipeline, stage, attempt);
  const canOpenFlow = Boolean(attempt?.flowId && renderableFlows.has(attempt.flowId));
  const canOpenPath = Boolean(attempt?.agentPath && renderablePaths.has(attempt.agentPath));
  return (
    /* Inline chip group living inside the shared conversation-chip strip (finding
       4): no separate row. Every hop/verdict control is a 44px tap target. */
    <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={t("pipelineMobile.chipAria", { task: pipeline.task })}>
      <span className="shrink-0 rounded-full bg-sunken px-1.5 py-1 text-[10px] font-bold text-muted" aria-hidden>⇢ {t("pipelineMobile.position", { k: index + 1, n: total })}</span>
      <button
        type="button"
        disabled={!prevHopEnabled}
        onClick={() => onHop(index - 1)}
        aria-label={t("pipelineMobile.prevStage")}
        className="inline-flex h-11 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[11px] font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
      >
        ‹ {prev ? stageChipLabel(t, prev) : ""}
      </button>
      <button
        type="button"
        disabled={!canOpenVerdict}
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-label={t("pipelineMobile.openVerdict", { label: stageChipLabel(t, stage) })}
        className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
        style={{ backgroundColor: tone.soft, color: tone.color }}
      >
        <span aria-hidden>{stage.kind === "review-loop" ? "⟳" : "▸"}</span>
        {stageChipLabel(t, stage)}
        {STAGE_GLYPH[state] ? <span aria-hidden>{STAGE_GLYPH[state]}</span> : null}
        <span className="text-[9px] font-semibold opacity-80">{t(`pipelineChipState.${state}`)}</span>
        {attempt?.verdict ? <span aria-hidden>{attempt.verdict.status === "pass" ? "✓" : attempt.verdict.status === "fail" ? "✕" : "●"}</span> : null}
      </button>
      <button
        type="button"
        disabled={!nextHopEnabled}
        onClick={() => onHop(index + 1)}
        aria-label={t("pipelineMobile.nextStage")}
        className="inline-flex h-11 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[11px] font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
      >
        {next ? stageChipLabel(t, next) : ""} ›
      </button>
      {sheetOpen && attempt ? (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSheetOpen(false);
          }}
        >
          <div className="mb-0 w-full max-w-[420px] rounded-t-[16px] bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2">
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" aria-hidden />
            <VerdictPopover
              pipeline={pipeline}
              stage={stage}
              attempt={attempt}
              canOpenFlow={canOpenFlow}
              canOpenPath={canOpenPath}
              onClose={() => setSheetOpen(false)}
              onOpenPath={(path) => { setSheetOpen(false); onOpenPath(path); }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Pipeline state → the header dot tone (busy accent, attention amber, done ok). */
function pipelineDotColor(pipeline: Pipeline): string {
  if (pipeline.state === "draft") return "var(--color-warning)";
  if (PIPELINE_BUSY_STATES.has(pipeline.state)) return "var(--color-accent)";
  if (PIPELINE_ATTENTION_STATES.has(pipeline.state)) return "var(--color-warning)";
  if (pipeline.state === "completed") return "var(--color-success)";
  return "var(--color-muted)";
}

/**
 * The docked mobile full-plan surface for an active pipeline (issues #136, #156).
 * It backs two cases the phone cannot otherwise plan out: a memberless pipeline
 * (no board node yet — the pick-only lite map needs ≥2 nodes to surface it), and
 * a memberful pipeline whose complete plan the mobile map suppresses (it passes
 * no pipelineControls, so GroupsLayer paints no strip there). This card shows the
 * full planned stage graph (past ✓ / current ▸ / ghost ○) and the pipeline-level
 * controls, every one a 44px tap target, so the plan and its actions live on the
 * phone board for every active pipeline, memberful ones included.
 */
export function MobilePipelineDock({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (action: PipelineAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fail = await patchPipeline(pipeline.id, action);
    if (fail) setError(fail);
    setBusy(false);
  };
  const draft = pipeline.state === "draft";
  const finished = pipeline.state === "completed" || pipeline.state === "closed";
  const parked = pipeline.state === "needs_decision";
  return (
    <div className={`flex flex-col gap-2 px-3 py-2 ${draft ? "border-y border-dashed border-warning/70 bg-warning-soft" : ""}`} data-testid="mobile-pipeline-dock" data-pipeline-draft={draft || undefined} role="group" aria-label={t("pipelineMobile.chipAria", { task: pipeline.task })}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: pipelineDotColor(pipeline) }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-primary">{cleanTitle(pipeline.task, 60)}</span>
        {draft ? <Badge tone="warning">{t("pipelineStrip.draftBadge")}</Badge> : null}
        <span className="shrink-0 text-[11px] font-semibold text-muted">{pipelineStateLabel(t, pipeline.state)}</span>
      </div>
      {/* The whole planned stage graph, scrolled horizontally — past/current/ghost. */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {pipeline.stages.map((stage) => {
          const state = stageChipState(pipeline, stage);
          const tone = STAGE_TONES[state];
          return (
            <span
              key={stage.id}
              className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full border px-3 text-[11px] font-bold"
              style={{ borderColor: tone.color, color: tone.color, backgroundColor: tone.soft }}
            >
              <span aria-hidden>{STAGE_GLYPH[state]}</span> {stageChipLabel(t, stage)}
            </span>
          );
        })}
      </div>
      {error ? <span className="text-[11px] font-semibold text-danger" role="alert">{error}</span> : null}
      {/* A closed pipeline is gone, so no controls; every other state — including
          completed — keeps Close so the operator can always dismiss it. Only
          pause/resume and retry/skip are gated on `finished` (mirrors the desktop
          PipelineStrip). Fixes the completed-pipeline dead end (review round 4). */}
      {pipeline.state === "closed" ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {draft ? (
            <button type="button" className="inline-flex h-11 items-center gap-1 rounded-full border border-accent bg-accent px-3.5 text-[11px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40" disabled={busy || pipeline.stages.length < 2} onClick={() => void mutate("start")}>
              <Play className="h-4 w-4" aria-hidden /> {t("pipelineStrip.start")}
            </button>
          ) : parked ? (
            <>
              <button type="button" className="inline-flex h-11 items-center rounded-full border border-accent bg-accent px-3.5 text-[11px] font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void mutate("retry-stage")}>{t("pipelineStrip.retryStage")}</button>
              <button type="button" className="inline-flex h-11 items-center rounded-full border border-border bg-canvas px-3.5 text-[11px] font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} onClick={() => void mutate("skip-stage")}>{t("pipelineStrip.skipStage")}</button>
            </>
          ) : null}
          {draft || finished ? null : pipeline.state === "paused" ? (
            <button type="button" className="inline-flex h-11 items-center gap-1 rounded-full border border-success/40 bg-success-soft px-3.5 text-[11px] font-bold text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} aria-label={t("pipelineStrip.resume")} onClick={() => void mutate("resume")}>
              <Play className="h-4 w-4" aria-hidden /> {t("pipelineStrip.resume")}
            </button>
          ) : (
            <button type="button" className="inline-flex h-11 items-center gap-1 rounded-full border border-border bg-canvas px-3.5 text-[11px] font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} aria-label={t("pipelineStrip.pause")} onClick={() => void mutate("pause")}>
              <Pause className="h-4 w-4" aria-hidden /> {t("pipelineStrip.pause")}
            </button>
          )}
          <button type="button" className="inline-flex h-11 items-center gap-1 rounded-full border border-border bg-canvas px-3.5 text-[11px] font-bold text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40" disabled={busy} aria-label={t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")} onClick={() => void mutate(draft ? "delete" : "close")}>
            <X className="h-4 w-4" aria-hidden /> {t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")}
          </button>
        </div>
      )}
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
        className={`flex h-11 shrink-0 items-center gap-1 rounded-full border px-3 text-[11px] font-semibold ${
          active ? "border-accent/60 bg-accent/10 text-primary" : "border-dashed border-border bg-canvas text-muted"
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
      className={`flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold ${
        active
          ? "border-accent/60 bg-accent/10 text-primary"
          : waiting
            ? "border-warning/60 bg-warning-soft text-warning"
            : "border-border bg-canvas text-muted"
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
