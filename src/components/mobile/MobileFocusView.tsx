"use client";

import { ListTodo, Map as MapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2, X } from "@/components/icons";
import { TaskSheet, type TaskSheetView } from "@/components/tasks/TaskSheet";
import { taskRelationsByPath } from "@/components/tasks/taskRelations";
import { viewBus } from "@/hooks/viewPresenceBus";
import { projectDisplayName } from "@/lib/displayNames";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
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
import { MIN_TRANSCRIPT_SHARE } from "./chatBudget";
import { paneState, type PaneState } from "@/components/paneState";
import type { BranchGroup } from "@/components/projectModel";
import { activityDot, cleanTitle, engineBadge } from "@/components/utils";

import { STAGE_GLYPH, STAGE_TONES, compactPipelineLayoutFlows, compactStageOpenTarget, latestAttempt, partitionPipelineSurfaces, pipelineLinkedTasks, renderableFlowIds, stageChipLabel, stageChipState, stageHasEvidence, stageHasNavigableHistory } from "@/components/pipelines/pipelineModel";
import { VerdictPopover } from "@/components/pipelines/VerdictPopover";
import { MobilePipelineDock } from "./MobilePipelineDock";
import { MobilePipelineDockSheet, MobilePipelineSummaryButton, MobilePipelineSummaryRow } from "./MobilePipelineDockSheet";
import { conversationIdentity } from "@/lib/accounts/identity";
import { SubagentTray, type SubagentTrayApi } from "../scheme/SubagentTrayView";
import { deckKey } from "@/components/scheme/agentLinks";
import { buildSchemeLayout } from "@/components/scheme/layout";
import { SubagentBadges } from "@/components/scheme/SubagentBadges";
import { layoutPipelineGroups, type PipelinePane } from "@/components/scheme/pipelineAnchor";
import { isPlacedTask, taskRect } from "@/components/scheme/taskGeometry";
import type { WorkerStack } from "@/components/scheme/workerCollapse";
import { MobileMapLite } from "./MobileMapLite";
import { SUBAGENT_RAIL_MIN_BOTTOM_PX, subagentRailBottom } from "./subagentRailLift";

/* Re-exported so existing importers (and tests) keep resolving it here after
   the component moved to its own module (issue #419). */
export { MobilePipelineDock } from "./MobilePipelineDock";

const focusKey = (project: string) => "llvFocus:" + project;

/* Attention-first default: the conversation whose move it is beats a running
   one, freshness breaks ties inside a class. */
const STATE_SCORE: Record<PaneState, number> = { waiting: 5, stalled: 4, live: 3, returned: 2, done: 1 };

/* Swipe on the pane header: mostly-horizontal and long enough to be deliberate. */
const SWIPE_MIN_X = 56;
const EMPTY_PATHS: ReadonlySet<string> = new Set();

/* Height of the phone's bottom-up subagent badge rail — the 12-badge hard cap
   at the coarse-pointer 44px pitch (30px circle + 14px gap), so every badge
   keeps its own non-overlapping ≥44px tap slot in a single column (issue #474
   follow-up). The rail anchors to the focused pane's left edge and lifts clear
   of the measured composer bounds, so a tap expands the title rightward inside
   the 390px viewport with no horizontal overflow. */
const SUBAGENT_RAIL_H = 12 * 44;

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
  /** Synthetic direct one-shot review groups (issue #325): joined with `flows`
      for the layout so their decks render, but excluded from every PATCH-backed
      flow control (renderableFlows and the pipeline focus row read real flows). */
  reviewGroups?: Flow[];
  pipelines: Pipeline[];
  /** Active project pipelines consumed directly by the mobile pipeline dock. */
  surfacePipelines?: Pipeline[];
  /** Collapsed worker stacks (issue #136): one dot per origin on the full-map
      minimap, so folded workers read as a handful of dots there too. */
  workerStacks?: WorkerStack[];
  /** Board-mounted tasks: mini-cards on the map (status-stacked cards are
      filtered out upstream and live in the compact strip). */
  tasks: BoardTask[];
  /** The project's FULL task list for the sheet and the count badge, so a
      status-stacked card stays reachable on the phone. Defaults to `tasks`. */
  sheetTasks?: BoardTask[];
  /** Ids of not-yet-spawned conversation drafts, focusable like nodes. */
  drafts: string[];
  /** Durable identities the user has crowned (issue #224): their roots lift into
      the pinned top band on the map, mirroring the desktop scheme. */
  favorites?: ReadonlySet<string>;
  /** Compact transcript paths opened as isolated history panes. */
  isolatedManualPaths?: ReadonlySet<string>;
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
  /** Engine-native subagent tray surface (issue #142): the focused parent's
      folded children render as inline rows inside its pane on the phone. */
  trayApi?: SubagentTrayApi;
}

/** The phone consumes the same memberful/shelf partition directly. */
export function pipelinesToDock(pipelines: readonly Pipeline[], memberfulGroupIds: ReadonlySet<string>): Pipeline[] {
  const partition = partitionPipelineSurfaces(pipelines, memberfulGroupIds);
  const visible = new Set([...partition.memberful, ...partition.shelf].map((pipeline) => pipeline.id));
  return pipelines.filter((pipeline) => visible.has(pipeline.id));
}

/**
 * The phone presentation of a project: one conversation pinned nearly
 * full-screen, a strip of status chips to hop between conversations, a
 * minimap chip that unfolds the whole scheme as a pick-only map. The same
 * data the scheme draws — nothing on the diagram is unreachable, it is just
 * shown one pane at a time.
 */
export function MobileFocusView({ project, groups, manual, files, flows, reviewGroups = [], pipelines, surfacePipelines = [], workerStacks = [], tasks, sheetTasks, drafts, favorites, isolatedManualPaths = EMPTY_PATHS, loaded, focus, onSelect, onClose, onDraftClose, onDraftSpawned, onActiveChange, taskSheetNonce = 0, trayApi }: Props) {
  const { t } = useLocale();
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [pipelineSheetOpen, setPipelineSheetOpen] = useState(false);
  const [mapFrame, setMapFrame] = useState<"all" | "current">("all");
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

  /* Direct review groups join the layout's flow list so their decks place
     beside the reviewed conversation exactly like managed loops (issue #325);
     everything action-backed below keeps reading the real `flows`. */
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  const layout = useMemo(
    () => buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths),
    [groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths],
  );
  const mobilePipelineOutlines = useMemo(() => {
    const live = surfacePipelines.filter((pipeline) => pipeline.state !== "completed" && pipeline.state !== "closed");
    const panes: PipelinePane[] = layout.nodes.map((node) => ({
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      path: node.file.path,
      conversationId: node.file.conversationId,
    }));
    const placedTasks = tasks.filter(isPlacedTask);
    const taskRects = placedTasks.map((task) => taskRect(task, false));
    const obstacles = [
      ...layout.nodes,
      ...layout.decks,
      ...layout.stacks,
      ...layout.drafts,
      ...layout.slots,
      ...taskRects,
    ];
    const placements = layoutPipelineGroups(live, tasks, panes, obstacles);
    return live.flatMap((pipeline) => {
      const placement = placements.get(pipeline.id);
      return placement ? [{ id: pipeline.id, title: pipeline.task, rect: placement.bounds }] : [];
    });
  }, [surfacePipelines, layout, tasks]);
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

  /* The side agent rail must never enter the composer/input/Send bounds (issue
     #474 follow-up): the phone composer grows to min(38dvh, 20rem), so a fixed
     bottom offset lets it swallow the lowest badges and their tap reveals. The
     rail's offset instead tracks the measured composer band plus the stable
     clearance gutter — re-measured when the pane area's DOM changes (the
     composer mounting, its textarea growing a style-driven row) or the window
     resizes, coalesced to one measurement per frame. */
  const paneAreaRef = useRef<HTMLDivElement | null>(null);
  const [railBottom, setRailBottom] = useState(SUBAGENT_RAIL_MIN_BOTTOM_PX);
  const activePanePath = activeNode?.file.path ?? null;
  useEffect(() => {
    const hostEl = paneAreaRef.current;
    if (!hostEl || !activePanePath) return;
    let frame = 0;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16) as unknown as number;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id: number) => window.clearTimeout(id);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
    let observedComposer: Element | null = null;
    const measure = () => {
      const composer = hostEl.querySelector('[data-testid="bounded-mobile-composer"]');
      if (resize && composer !== observedComposer) {
        if (observedComposer) resize.unobserve(observedComposer);
        if (composer) resize.observe(composer);
        observedComposer = composer;
      }
      const composerTop = composer ? composer.getBoundingClientRect().top : null;
      setRailBottom(subagentRailBottom(hostEl.getBoundingClientRect().bottom, composerTop));
    };
    const schedule = () => {
      if (frame) return;
      frame = raf(() => { frame = 0; measure(); });
    };
    measure();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    observer?.observe(hostEl, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) caf(frame);
      observer?.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [activePanePath]);
  /* Report the focused conversation up so the project shell can dock its handoff
     control in the footer shelf row (issue #177 item 5). Cleared on unmount so a
     switch to the list view drops the stale handoff target. */
  useEffect(() => {
    onActiveChange?.(activeNode?.file ?? null);
  }, [activeNode, onActiveChange]);
  useEffect(() => () => onActiveChange?.(null), [onActiveChange]);
  const memberfulPipelineIds = useMemo(
    () => new Set(layout.groups.filter((group) => group.kind === "pipeline" && group.pipeline).map((group) => group.id)),
    [layout.groups],
  );
  const dockedPipelines = useMemo(
    () => pipelinesToDock(surfacePipelines, memberfulPipelineIds),
    [surfacePipelines, memberfulPipelineIds],
  );

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
  const renderableFlows = useMemo(() => renderableFlowIds(layoutFlows, new Set(layout.nodes.map((node) => node.file.path))), [layoutFlows, layout]);
  const linkedTasksByPipeline = useMemo(
    () => new Map(pipelines.map((pipeline) => [pipeline.id, pipelineLinkedTasks(pipeline, sheetTasks ?? tasks, flows, files)] as const)),
    [pipelines, sheetTasks, tasks, flows, files],
  );
  /* Conversation-side relation strip (issue #292): the focused phone pane lists
     its assigned/captured tasks; a tap opens that task in the sheet. */
  const relatedTasksByPath = useMemo(() => taskRelationsByPath(files, sheetTasks ?? tasks), [files, sheetTasks, tasks]);

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
    const target = compactStageOpenTarget(stage, latestAttempt(pipelineFocus.pipeline, stage.id), flows, renderableFlows, renderablePaths, files);
    if (!target) return;
    if (target.kind === "flow") {
      const key = deckKey(target.flowId);
      if (byKey.has(key)) setFocusPath(key);
      return;
    }
    openStagePath(target.path);
  };

  const openPipelineTask = useCallback((task: BoardTask) => setTaskSheet({ taskId: task.id }), []);
  const openPipelineFlow = useCallback((flowId: string) => {
    const key = deckKey(flowId);
    if (byKey.has(key)) setFocusPath(key);
  }, [byKey]);

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
    /* The mobile overflow contract (#353): the focus root clips horizontal
       overflow at the viewport, so any horizontal scrolling lives ONLY in
       internal `overflow-x-auto` strips (chip row, dock rail) with `min-w-0`
       ancestors — never on the document. Measured acceptance: at 390px the
       document scrollWidth equals the innerWidth (the production record showed
       564px before this fix). */
    <div
      data-testid="mobile-chat-shell"
      /* The chat-first budget contract (issue #419) rides the DOM it governs:
         with the secondary chrome folded by default, the transcript owns at
         least this share of the usable viewport before the keyboard opens. */
      data-chat-min-share={MIN_TRANSCRIPT_SHARE}
      className="relative flex h-full max-h-[100dvh] min-h-0 min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden overflow-x-clip"
    >
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
            <div ref={chipScrollRef} onScroll={syncChipFade} className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-2 py-1">
              {pipelineFocus ? (
                <>
                  <PipelineFocusRow pipeline={pipelineFocus.pipeline} index={pipelineFocus.index} flows={flows} files={files} renderableFlows={renderableFlows} renderablePaths={renderablePaths} onHop={hopToStage} onOpenPath={openStagePath} />
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
          {/* Chat-first (issue #419 reopened): with a conversation focused the
              docked pipelines reserve ZERO height below the transcript — this
              compact trigger rides the strip and opens the same bottom sheet. */}
          {(activeNode || activeDeck || activeDraft) && dockedPipelines.length ? (
            <MobilePipelineSummaryButton pipelines={dockedPipelines} onOpen={() => setPipelineSheetOpen(true)} />
          ) : null}
          {/* Collapsed worker stacks count toward map availability (issue #136):
              a worker-heavy board is often one visible root plus several stacks,
              and the map is the only place their per-origin dots can be seen. */}
          {mapReachable(layout.nodes.length, workerStacks.length, mobilePipelineOutlines.length) ? (
            <button
              type="button"
              className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-[8px] text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("mobile.openMap")}
              onClick={() => { setMapFrame("all"); setMapOpen(true); }}
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
            {(sheetTasks ?? tasks).filter((task) => task.status !== "done").length ? (
              <span className="rounded-full bg-accent/10 px-1 text-[10px] font-bold text-accent">
                {(sheetTasks ?? tasks).filter((task) => task.status !== "done").length}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {/* Even card gutters that also clear the notch/rounded corners (finding 8):
          the safe-area insets keep the pane off the screen edges symmetrically. */}
      <div ref={paneAreaRef} className="relative flex min-h-0 flex-1 flex-col pt-1 pl-[max(0.375rem,env(safe-area-inset-left))] pr-[max(0.375rem,env(safe-area-inset-right))] pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        {activeNode ? (
          /* The handoff control for this pane docks in the footer shelf row
             (issue #177 item 5), so the focus view itself renders only the pane. */
          <div key={activeNode.file.path} data-testid="mobile-focused-pane" className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-h-0 min-w-0 flex-1">
              <BranchPane
                file={activeNode.file}
                tasks={activeNode.tasks}
                isRoot={activeNode.isRoot}
                showFavorite
                onClose={() => onClose(activeNode.file.path)}
                dragHandle={swipeHandle}
                relatedTasks={relatedTasksByPath.get(activeNode.file.path)}
                onOpenTask={openPipelineTask}
              />
            </div>
            {(() => {
              const tray = trayApi?.trays.get(conversationIdentity(activeNode.file));
              /* The focused parent's folded engine children stay inside its pane
                 on the phone (§S2 mobile): inline rows, 44px targets, read-only
                 open — never a durable membership change. */
              return tray ? (
                <SubagentTray
                  tray={tray}
                  variant="inline"
                  onToggleExpanded={(expanded) => trayApi!.onToggleExpanded(tray.parentConversationId, expanded)}
                  onOpenMember={trayApi!.onOpenMember}
                  onUnfold={trayApi!.onUnfold}
                />
              ) : null;
            })()}
          </div>
        ) : activeDeck ? (
          <div key={activeDeck.key} className="relative min-h-0 flex-1">
            <RoundDeck
              flow={activeDeck.flow}
              rounds={activeDeck.rounds}
              focusRound={null}
              groupLabel={files.find((entry) => entry.path === activeDeck.flow.implementerPath)?.title}
            />
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
                <MobilePipelineDock key={pipeline.id} pipeline={pipeline} flows={flows} files={files} renderablePaths={renderablePaths} renderableFlows={renderableFlows} linkedTasks={linkedTasksByPipeline.get(pipeline.id) ?? []} onOpenPath={openStagePath} onOpenFlow={openPipelineFlow} onOpenTask={openPipelineTask} />
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
        {/* The subagent badge/anchor interaction on the phone (PR #441): the same
            30x30 bottom-up circles the desktop board carries, anchored to the
            focused pane's left edge and lifted above the MEASURED composer
            bounds plus the stable clearance gutter (issue #474 follow-up). A
            hover/tap expands the title, a second tap navigates to the child's
            CURRENT generation. The overlay is pointer-events-none so only the
            badges themselves take taps; expansion grows rightward within the
            390px viewport, so it never adds horizontal overflow. */}
        {activeNode ? (
          <div
            data-testid="mobile-subagent-rail"
            className="pointer-events-none absolute left-2 z-[20]"
            style={{ width: 0, height: SUBAGENT_RAIL_H, bottom: railBottom }}
          >
            <SubagentBadges
              conversationId={conversationIdentity(activeNode.file)}
              entries={files}
              cardRect={{ x: 0, y: 0, w: 0, h: SUBAGENT_RAIL_H }}
              onNavigate={(path) => {
                const target = files.find((entry) => entry.path === path);
                if (target) onSelect(target);
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Chat owns the viewport (issue #419 reopened): the docked pipelines no
          longer reserve ANY row below the transcript — the compact trigger in the
          top strip opens the same bottom sheet, so the focused chat keeps the full
          bottom of the viewport for the composer. */}

      {mapOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-canvas pb-[env(safe-area-inset-bottom)]">
          <div className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1.5">
            <span className="shrink-0 pl-1 text-[13px] font-bold">{t("mobile.map")}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{projectDisplayName(project)}</span>
            {/* role="group" — aria-label on a role-less div is ignored by
                accessibility APIs, so AT would hear two bare toggle buttons
                with no "Map framing" context (round-1 review). */}
            <div role="group" className="flex shrink-0 rounded-full border border-border bg-canvas p-0.5" aria-label={t("mobile.mapFrame")}>
              {(["all", "current"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mapFrame === value}
                  className={`min-h-11 rounded-full px-3 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    mapFrame === value ? "bg-card text-accent shadow-1" : "text-muted"
                  }`}
                  onClick={() => setMapFrame(value)}
                >
                  {t(value === "all" ? "mobile.mapAll" : "mobile.mapCurrent")}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("mobile.closeMap")}
              onClick={() => setMapOpen(false)}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {/* Bounded lightweight projection (issue #418): fed the layout memo the
              focus view already computed — no second buildSchemeLayout, no
              world-sized composited layer, no transcript/pane mount, and zero
              fetches on open — so it survives the largest board over Tailscale
              where the full SchemeBoard OOM-killed the tab. */}
          <MobileMapLite
            layout={layout}
            tasks={tasks}
            workerStacks={workerStacks}
            pipelineOutlines={mobilePipelineOutlines}
            frame={mapFrame}
            ringKey={resolvedKey}
            onPick={pickFromMap}
          />
          {/* The lite map is pick-only and cannot paint a readable stage strip at
              its zoom, so it never surfaces a pipeline's full plan on its own.
              The same one-row summary rides below it (issue #419) — a tap opens
              the sheet, keeping every active pipeline's full plan reachable
              without a stack of rows stealing the map (issue #156). */}
          {dockedPipelines.length ? (
            <MobilePipelineSummaryRow pipelines={dockedPipelines} onOpen={() => setPipelineSheetOpen(true)} />
          ) : null}
          <div className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-center text-[11px] text-muted">
            {t("mobile.tapNode")}
          </div>
        </div>
      ) : null}

      {pipelineSheetOpen && dockedPipelines.length ? (
        <MobilePipelineDockSheet
          pipelines={dockedPipelines}
          render={{
            flows,
            files,
            renderablePaths,
            renderableFlows,
            linkedTasksByPipeline,
            onOpenPath: openStagePath,
            onOpenFlow: openPipelineFlow,
            onOpenTask: openPipelineTask,
          }}
          onClose={() => setPipelineSheetOpen(false)}
        />
      ) : null}

      {taskSheet ? (
        <TaskSheet project={project} tasks={sheetTasks ?? tasks} files={files} initialView={taskSheet} onClose={() => setTaskSheet(null)} />
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
function PipelineFocusRow({ pipeline, index, flows, files, renderableFlows, renderablePaths, onHop, onOpenPath }: { pipeline: Pipeline; index: number; flows: Flow[]; files: readonly FileEntry[]; renderableFlows: ReadonlySet<string>; renderablePaths: ReadonlySet<string>; onHop: (index: number) => void; onOpenPath: (path: string) => void }) {
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
  const prevHopEnabled = prev ? Boolean(compactStageOpenTarget(prev, latestAttempt(pipeline, prev.id), flows, renderableFlows, renderablePaths, files)) : false;
  const nextHopEnabled = next ? Boolean(compactStageOpenTarget(next, latestAttempt(pipeline, next.id), flows, renderableFlows, renderablePaths, files)) : false;
  const attempt = latestAttempt(pipeline, stage.id);
  const stateLabel = t(`pipelineChipState.${state}`);
  const prevLabel = prev ? stageChipLabel(t, prev) : "";
  const prevState = prev ? t(`pipelineChipState.${stageChipState(pipeline, prev)}`) : "";
  const nextLabel = next ? stageChipLabel(t, next) : "";
  const nextState = next ? t(`pipelineChipState.${stageChipState(pipeline, next)}`) : "";
  /* Match the shared strip: visible evidence and openable retry or review-round
     history both keep the mobile sheet available. */
  const canOpenVerdict = stageHasEvidence(pipeline, stage, attempt)
    || stageHasNavigableHistory(pipeline, stage, attempt, flows, renderablePaths, files);
  const canOpenFlow = Boolean(attempt?.flowId && renderableFlows.has(attempt.flowId));
  const canOpenPath = Boolean(attempt?.agentPath && renderablePaths.has(attempt.agentPath));
  return (
    /* Inline chip group living inside the shared conversation-chip strip (finding
       4): no separate row. Every hop/verdict control is a 44px tap target. */
    <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={t("pipelineMobile.chipAria", { task: pipeline.task })} data-testid="mobile-pipeline-focus-row">
      <span className="shrink-0 rounded-full bg-sunken px-1.5 py-1 text-[10px] font-bold text-muted" aria-hidden>⇢ {t("pipelineMobile.position", { k: index + 1, n: total })}</span>
      {prev ? (
        <button
          type="button"
          disabled={!prevHopEnabled}
          onClick={() => onHop(index - 1)}
          aria-label={t("pipelineMobile.prevStage", { label: prevLabel, state: prevState })}
          className="inline-flex h-11 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[11px] font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
        >
          ‹ {stageChipLabel(t, prev)}
        </button>
      ) : null}
      <button
        type="button"
        disabled={!canOpenVerdict}
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-label={t("pipelineMobile.openVerdict", { label: stageChipLabel(t, stage), state: stateLabel })}
        className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
        style={{ backgroundColor: tone.soft, color: tone.color }}
      >
        <span aria-hidden>{stage.kind === "review-loop" ? "⟳" : "▸"}</span>
        {stageChipLabel(t, stage)}
        {STAGE_GLYPH[state] ? <span aria-hidden>{STAGE_GLYPH[state]}</span> : null}
        <span className="text-[9px] font-semibold opacity-80">{t(`pipelineChipState.${state}`)}</span>
        {attempt?.verdict ? <span aria-hidden>{attempt.verdict.status === "pass" ? "✓" : attempt.verdict.status === "fail" ? "✕" : "●"}</span> : null}
      </button>
      {next ? (
        <button
          type="button"
          disabled={!nextHopEnabled}
          onClick={() => onHop(index + 1)}
          aria-label={t("pipelineMobile.nextStage", { label: nextLabel, state: nextState })}
          className="inline-flex h-11 shrink-0 items-center rounded-full border border-border bg-card px-3 text-[11px] font-bold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
        >
          {stageChipLabel(t, next)} ›
        </button>
      ) : null}
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
              flows={flows}
              files={files}
              availablePaths={renderablePaths}
              mobile
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
