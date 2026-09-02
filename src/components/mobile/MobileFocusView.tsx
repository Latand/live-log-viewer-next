"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2 } from "@/components/icons";
import { TaskSheet, type TaskSheetView } from "@/components/tasks/TaskSheet";
import { taskRelationsByPath } from "@/components/tasks/taskRelations";
import { useBoardState } from "@/hooks/useBoardState";
import { useKeyboardInset } from "@/hooks/useComposer";
import { useRuntimeBusState } from "@/hooks/useRuntime";
import { selectionInOrder, viewBus } from "@/hooks/viewPresenceBus";
import { projectDisplayName } from "@/lib/displayNames";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { BranchPane } from "@/components/BranchPane";
import { DraftAgentPane } from "@/components/DraftAgentPane";
import { isWorkflowDraftId } from "@/components/workflows/workflowModel";
import { WorkflowDraftPane } from "@/components/workflows/WorkflowDraftPane";
import { RoundDeck } from "@/components/flows/RoundDeck";
import { MIN_TRANSCRIPT_SHARE } from "./chatBudget";
import { ChatEngineMark } from "./chatEngineMark";
import { paneState, type PaneState } from "@/components/paneState";
import type { BranchGroup } from "@/components/projectModel";
import { draftWorkingDirectory } from "@/components/projectModel";
import { cleanTitle, engineBadge, effortTitle } from "@/components/utils";

import { compactPipelineLayoutFlows, partitionPipelineSurfaces, pipelineLinkedTasks, renderableFlowIds } from "@/components/pipelines/pipelineModel";
import { MobilePipelineDock } from "./MobilePipelineDock";
import { MobilePipelineDockSheet } from "./MobilePipelineDockSheet";
import { conversationIdentity } from "@/lib/accounts/identity";
import { useFavorites } from "@/components/favorites/FavoritesContext";
import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { SessionTitle } from "@/components/session/SessionTitle";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { deckKey } from "@/components/scheme/agentLinks";
import { buildFocusFrameIndex, stageAnchorAliases } from "@/components/scheme/focusFrames";
import { buildSchemeLayout } from "@/components/scheme/layout";
import { SubagentBadges } from "@/components/scheme/SubagentBadges";
import type { WorkerStack } from "@/components/scheme/workerCollapse";

import { MobileBarTitle, MobileShell, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { MobileConversationMenu } from "./MobileConversationMenu";
import { MobileSwitchSheet, switchList, swipeTarget, type SwitchCandidate, type SwitchEntry } from "./MobileSwitchSheet";
import { CHAT_TONE_DOT, CHAT_TONE_TEXT, chatStateBits, stagePosition, type StagePosition } from "./mobileChatState";
import { topScreen, useMobileNav, useMobileNavStore } from "./mobileNav";

/* Re-exported so existing importers (and tests) keep resolving it here after
   the component moved to its own module (issue #419). */
export { MobilePipelineDock } from "./MobilePipelineDock";

const focusKey = (project: string) => "llvFocus:" + project;
/** The pane this tab last pinned in `project`, or null (also on the server). */
function rememberedFocus(project: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(focusKey(project));
  } catch {
    return null;
  }
}

/* Attention-first default: the conversation whose move it is beats a running
   one, freshness breaks ties inside a class. */
const STATE_SCORE: Record<PaneState, number> = { waiting: 5, stalled: 4, live: 3, returned: 2, done: 1 };

/* A swipe across the bar or the dock: mostly-horizontal and long enough to be
   deliberate. The prototype uses the same 56 px / 2:1 test. */
const SWIPE_MIN_X = 56;
/** Where a horizontal swipe switches conversations (README §3.3). Anywhere
    else — the feed above all — keeps its own scrolling. */
export const SWIPE_ZONE = "[data-mobile2-bar], [data-mobile2-dock]";
/** How long the title cell's end-of-list bump runs (§5). */
export const BUMP_MS = 200;
const EMPTY_PATHS: ReadonlySet<string> = new Set();

/* Height of the phone's bottom-up subagent badge rail — the 12-badge hard cap
   at 30 px + 6 px gaps. It anchors to the focused pane's left edge and lifts
   clear of the composer; expansion grows rightward inside the 390 px viewport,
   so it never adds horizontal overflow. */
const SUBAGENT_RAIL_H = 12 * 36;

/** True when a touch that landed on `target` belongs to the swipe zone. */
export function inSwipeZone(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return Boolean(element && typeof element.closest === "function" && element.closest(SWIPE_ZONE));
}

interface Entry {
  key: string;
  file: FileEntry | null;
  isRoot: boolean;
  kind: "node" | "draft" | "deck";
}

interface Props {
  project: string;
  projectName?: string;
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
  /** Collapsed worker stacks (issue #136); kept for the layout's own use. */
  workerStacks?: WorkerStack[];
  /** Board-mounted tasks. */
  tasks: BoardTask[];
  /** The project's FULL task list for the sheet and the count badge, so a
      status-stacked card stays reachable on the phone. Defaults to `tasks`. */
  sheetTasks?: BoardTask[];
  /** Ids of not-yet-spawned conversation drafts, focusable like nodes. */
  drafts: string[];
  /** Durable identities the user has crowned (issue #224). */
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
  /** The operator opened this conversation full-pane, the same signal
      `SchemeBoard` reports from a desktop expand. On the phone the gesture is a
      switcher row, a map pick or the attention row — the deliberate act the
      board counts as having SEEN a finished lane's outcome (#1244). */
  onConversationOpened?: (path: string) => void;
  /** Reports the focused conversation's file (or null) so the project shell can
      dock a single handoff control in the host sheet (issue #177 item 5). */
  onActiveChange?: (file: FileEntry | null) => void;
  /* ── The shell (mobile v2 lane 3) ──────────────────────────────────────── */
  /** The Viewer's shell host: the attention badge, the arrival banner and the
      sheets it owns (the project switcher, the queue, search). */
  shellHost?: MobileShellHost | null;
  /** The project board's own sheets — its `⋯` menu and the host sheet — for
      the sheet names this screen does not own. */
  renderBoardSheet?: SheetRenderer;
  /** The search palette (#1054): a bar target on the board, a `⋯` row here. */
  onOpenSearch?: () => void;
  /** Background tasks behind «Details & host», as the menu row's count. */
  hostTaskCount?: number;
  /** Drops a draft that continues a conversation, for the menu's «Hand off»
      row (§4.2). The board owns the draft, so the screen only asks for it. */
  onHandoff?: (file: FileEntry) => void;
  /** In-flow alert the project board renders above the leaf. */
  alert?: React.ReactNode;
}

/** The phone consumes the same memberful/shelf partition directly. */
export function pipelinesToDock(pipelines: readonly Pipeline[], memberfulGroupIds: ReadonlySet<string>): Pipeline[] {
  const partition = partitionPipelineSurfaces(pipelines, memberfulGroupIds);
  const visible = new Set([...partition.memberful, ...partition.shelf].map((pipeline) => pipeline.id));
  return pipelines.filter((pipeline) => visible.has(pipeline.id));
}

/**
 * The phone's CONVERSATION SCREEN (docs/design/mobile-v2/README.md §4.2, §8
 * row 3).
 *
 * What used to be here — a 56 px strip carrying the pinned seat, a scroller of
 * engine-labelled chips, the pipeline hop chips and a right cluster of map and
 * task buttons — is gone. It cost the transcript a permanent row, it named
 * conversations by their engine ("Claude · Claude · Claude"), and its trailing
 * icons collided with the chip scroller's fade at 390 px (§1.3).
 *
 * In its place the shell's ONE bar carries the conversation: the title on one
 * line, and a meta line under it whose state phrase never truncates (§3.2).
 * The title cell is the switcher; a swipe across the bar or the dock walks the
 * switcher's order minus Recent and bumps at either end; `⋯` holds every
 * former header control as a labelled row. The screen owns no chrome of its
 * own, so the transcript gets everything under the bar.
 *
 * With no conversation to show — an empty project, a board whose nodes have
 * not loaded — the same shell renders the board leaf, which lane 2 fills with
 * the board list.
 */
export function MobileFocusView({ project, projectName, groups, manual, files, flows, reviewGroups = [], pipelines, surfacePipelines = [], tasks, sheetTasks, drafts, favorites, isolatedManualPaths = EMPTY_PATHS, loaded, focus, onSelect, onClose, onDraftClose, onDraftSpawned, onConversationOpened, onActiveChange, shellHost = null, renderBoardSheet, onOpenSearch, hostTaskCount = 0, onHandoff, alert }: Props) {
  const { t } = useLocale();
  /* The project-scoped board store, read here for the ONE canonical selection
     (#771). Same store the desktop board and the dashboard bind — stores are
     refcounted per project, so this is the same instance, never a copy. */
  const board = useBoardState(project);
  /* The on-screen keyboard's overlap with this full-height root (#983). iOS
     Safari ignores interactive-widget=resizes-content, so with the keyboard up
     this 100dvh column kept its full height and the keyboard covered its
     bottom — the composer's picker/send controls included. Padding the overlap
     away keeps the whole column inside the visible area. */
  const kbInset = useKeyboardInset();
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  /* Offline is screen-level (§4.2): every conversation shows the last state
     received and the bar's meta line says so. */
  const runtime = useRuntimeBusState();
  const offline = runtime.enabled && runtime.connection === "offline";
  const favoritesApi = useFavorites();
  /* The pinned pane, tagged with the project it belongs to. A project switch
     re-reads that project's remembered focus DURING the render that changes
     `project` (#1432). */
  const [focusState, setFocusState] = useState<{ project: string; key: string | null }>(() => ({ project, key: rememberedFocus(project) }));
  if (focusState.project !== project) setFocusState({ project, key: rememberedFocus(project) });
  const focusPath = focusState.key;
  const setFocusPath = useCallback((key: string | null) => setFocusState((prev) => (prev.key === key ? prev : { project: prev.project, key })), []);
  const [pipelineSheetOpen, setPipelineSheetOpen] = useState(false);
  const [taskSheet, setTaskSheet] = useState<TaskSheetView | null>(null);
  /* Bumped by the menu's Rename row: the editor opens over the bar, where the
     title cell is (§4.2, #1348). The editor reports the effective title back,
     so the cell under it shows an optimistic rename at once instead of waiting
     for the next scan poll. */
  const [renameToken, setRenameToken] = useState(0);
  const [renamed, setRenamed] = useState<{ path: string; title: string } | null>(null);
  /* The `⋯` sheet has two faces while the board has no screen of its own: the
     conversation's menu, and the project's. Lane 2 gives the board its own
     screen with its own `⋯`, and the second face goes away with it. */
  const [menuFace, setMenuFace] = useState<"chat" | "board">("chat");
  /* Closing the sheet returns it to the conversation's own face; a row inside
     the project menu closes it through the store, so this watches the store
     rather than any one close handler. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the sheet is gone; its face resets with it */
    if (!navState.sheet && menuFace !== "chat") setMenuFace("chat");
  }, [navState.sheet, menuFace]);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  /* Direct review groups join the layout's flow list so their decks place
     beside the reviewed conversation exactly like managed loops (issue #325). */
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  const layout = useMemo(
    () => buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths),
    [groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths],
  );
  /* Scheme order (depth-first, groups left to right) is the order the switcher
     lists inside each of its sections. */
  const entries = useMemo<Entry[]>(
    () => [
      ...layout.nodes.map((node) => ({ key: node.file.path, file: node.file, isRoot: node.isRoot, kind: "node" as const })),
      ...layout.decks.map((deck) => ({ key: deck.key, file: null, isRoot: false, kind: "deck" as const })),
      ...layout.drafts.map((draft) => ({ key: draft.key, file: null, isRoot: true, kind: "draft" as const })),
    ],
    [layout],
  );
  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);

  /* #688: the phone's half of a focus handoff. It resolves anchors through the
     same index the desktop board publishes, but arrives by pinning the pane
     rather than by moving a camera. */
  const focusIndex = useMemo(() => buildFocusFrameIndex(layout, project, { aliases: stageAnchorAliases(pipelines) }), [layout, project, pipelines]);
  useEffect(() => focusHandoffBus.setBoard({
    project,
    index: focusIndex,
    moveTo: ({ anchorKeys }) => {
      const landing = anchorKeys.find((key) => byKey.has(key));
      if (!landing) return false;
      setFocusPath(landing);
      return true;
    },
    restoreCamera: () => false,
  }), [project, focusIndex, byKey, setFocusPath]);

  /* Any open (overview card, toast, switch of a quiet branch) arrives as the
     transient highlight: pin it. */
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the opener's highlight is the pin */
    if (focus) setFocusPath(focus);
  }, [focus, setFocusPath]);

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

  const activeNode = useMemo(() => layout.nodes.find((node) => node.file.path === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeDeck = useMemo(() => layout.decks.find((deck) => deck.key === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeDraft = useMemo(() => layout.drafts.find((draft) => draft.key === resolvedKey) ?? null, [layout, resolvedKey]);
  const activeFile = activeNode?.file ?? null;
  /* Report the focused conversation up so the project shell can dock its
     handoff control in the host sheet (issue #177 item 5). */
  useEffect(() => {
    onActiveChange?.(activeFile);
  }, [activeFile, onActiveChange]);
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
     (a deck/draft carries no transcript path, so focus is null there). */
  useEffect(() => {
    const focusedPath = activeFile ? activeFile.path : null;
    const boardOrder = layout.nodes.map((node) => node.file.path);
    viewBus.reportSlice({
      mode: "mobile-focus",
      focusedPath,
      selectedPaths: selectionInOrder(boardOrder, board.selection, { includeUnordered: true }),
      visiblePaths: activeFile ? [activeFile.path] : [],
      camera: null,
    });
  }, [activeFile, layout, board.selection]);

  /* Where the focused conversation sits in its pipeline: the bar's `stage k/n`
     and the menu's first row (P2-9). A review-loop stage is represented on the
     board by its round deck, so the focused deck's flow matches too. */
  const stage = useMemo(
    () => stagePosition(pipelines, activeFile ? activeFile.path : null, activeDeck ? activeDeck.flow.id : null),
    [pipelines, activeFile, activeDeck],
  );
  const renderablePaths = useMemo(() => new Set(files.map((entry) => entry.path)), [files]);
  const renderableFlows = useMemo(() => renderableFlowIds(layoutFlows, new Set(layout.nodes.map((node) => node.file.path))), [layoutFlows, layout]);
  const linkedTasksByPipeline = useMemo(
    () => new Map(pipelines.map((pipeline) => [pipeline.id, pipelineLinkedTasks(pipeline, sheetTasks ?? tasks, flows, files)] as const)),
    [pipelines, sheetTasks, tasks, flows, files],
  );
  /* Conversation-side relation strip (issue #292). */
  const relatedTasksByPath = useMemo(() => taskRelationsByPath(files, sheetTasks ?? tasks), [files, sheetTasks, tasks]);

  const openStagePath = useCallback(
    (path: string) => {
      const file = files.find((entry) => entry.path === path);
      if (file) onSelect(file);
    },
    [files, onSelect],
  );
  const openPipelineTask = useCallback((task: BoardTask) => setTaskSheet({ taskId: task.id }), []);
  const openPipelineFlow = useCallback((flowId: string) => {
    const key = deckKey(flowId);
    if (byKey.has(key)) setFocusPath(key);
  }, [byKey, setFocusPath]);

  /* Pin a pane the layout already holds, as the phone's OPEN gesture (#1244).
     A switcher row and a map/attention pick are the same deliberate act as
     clicking a card on the desktop board, so each one stamps the durable
     acknowledgement that releases a held finished outcome.

     What deliberately does NOT stamp: the bar/dock swipe, the attention
     fallback inside `resolvedKey`, and the `onActiveChange` report. Passing a
     card, or having it surface on its own, is not reading it. */
  const openEntry = useCallback(
    (key: string) => {
      setFocusPath(key);
      const file = byKey.get(key)?.file;
      if (file) onConversationOpened?.(file.path);
    },
    [byKey, onConversationOpened, setFocusPath],
  );

  /* ── The switcher, and the swipe that walks it ─────────────────────────── */
  const projectCwd = useMemo(() => draftWorkingDirectory(files, project), [files, project]);
  const { status: seatStatus } = useOrchestratorSeat(project, projectCwd || undefined);
  const seatConversationId = seatStatus?.exists ? seatStatus.seat?.conversationId ?? null : null;
  const seatKey = useMemo(() => {
    if (!seatConversationId) return null;
    const seated = layout.nodes.find((node) => node.file.conversationId === seatConversationId);
    return seated?.file.path ?? seatStatus?.seat?.path ?? null;
  }, [layout.nodes, seatConversationId, seatStatus]);
  /* Everything the retired chip strip could pin is a switcher row, so removing
     the strip costs no destination: the conversations, the review-round decks
     that stand in for a folded reviewer transcript (#325 — a deck names the
     work it reviews and takes its state from its newest round), and the
     not-yet-spawned drafts, which sit in their own section outside the swipe. */
  const switchEntries = useMemo(() => {
    const candidates: SwitchCandidate[] = layout.nodes.map((node) => ({ key: node.file.path, file: node.file }));
    for (const deck of layout.decks) {
      const newest = [...deck.rounds].reverse().find((round) => round.file);
      const reviewed = files.find((entry) => entry.path === deck.flow.implementerPath);
      candidates.push({
        key: deck.key,
        file: newest?.file ?? null,
        label: t("mobile2.chat.reviewOf", { title: cleanTitle(reviewed?.title ?? deck.flow.implementerPath, 60) }),
        meta: t("scheme.flow"),
        /* A deck whose rounds carry no transcript yet has no state to read;
           it still belongs with the work, never among the drafts. */
        section: newest?.file ? undefined : "recent",
      });
    }
    for (const draft of layout.drafts) {
      candidates.push({ key: draft.key, file: null, label: t("mobile2.chat.draft"), meta: t("mobile2.chat.draftMeta"), section: "drafts" });
    }
    return switchList(candidates, { seatKey });
  }, [layout.nodes, layout.decks, layout.drafts, files, seatKey, t]);

  /* A sibling switch REPLACES what is on screen (§3.3): ‹ still leaves the way
     the operator came in, so it never grows the history. The stack's top has to
     move with it — a chat entry naming the conversation the operator left would
     send the next back gesture to the wrong place — but only when a chat screen
     IS the top: while the conversation is the phone's own leaf (lane 2 has yet
     to give the board its screen) the bottom of the stack is the board and
     stays that way. */
  const switchTo = useCallback((entry: SwitchEntry, stampSeen: boolean) => {
    if (stampSeen) openEntry(entry.key);
    else setFocusPath(entry.key);
    if (topScreen(navState).kind === "chat") nav.replace({ kind: "chat", id: entry.id });
  }, [openEntry, setFocusPath, nav, navState]);

  const [bumpPulse, setBumpPulse] = useState<{ side: "left" | "right"; id: number } | null>(null);

  const swipe = useCallback((dx: number) => {
    const direction = dx < 0 ? 1 : -1;
    const target = swipeTarget(switchEntries, resolvedKey, direction as 1 | -1);
    if (!target) {
      const side = direction === 1 ? "right" : "left";
      nav.bump(side);
      /* The id restarts the displacement when the operator swipes the end
         twice: without it the state is unchanged and the cell sits still. */
      setBumpPulse((previous) => ({ side, id: (previous?.id ?? 0) + 1 }));
      return;
    }
    /* A step that lands ends whatever bump the last one at the edge started. */
    nav.clearBump();
    setBumpPulse(null);
    switchTo(target, false);
  }, [switchEntries, resolvedKey, nav, switchTo]);

  /* Two halves of one gesture, on two clocks. The MARKER on the title cell
     records that the last swipe found nothing to step to, and stays until one
     lands — the prototype's `bump-r` class behaves exactly so, and the
     capture reads the marker after the gesture has settled. The 12 px
     DISPLACEMENT is the part the eye gets: it springs back after BUMP_MS, so
     a cell that hit the end does not sit shifted for as long as the operator
     stays. */
  useEffect(() => {
    if (!bumpPulse) return;
    const timer = window.setTimeout(() => setBumpPulse(null), BUMP_MS);
    return () => window.clearTimeout(timer);
  }, [bumpPulse]);

  const onTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    swipeRef.current = touch && inSwipeZone(event.target) ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || !activeFile || navState.sheet) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 2) return;
    swipe(dx);
  };

  /* ── The bar's title cell ──────────────────────────────────────────────── */
  const displayName = projectDisplayName(project, projectName);
  const title = activeFile ? (
    <ChatBarTitle
      file={activeFile}
      offline={offline}
      stage={stage}
      bump={bumpPulse?.side ?? null}
      renamed={renamed && renamed.path === activeFile.path ? renamed.title : null}
    />
  ) : (
    <MobileBarTitle>{displayName}</MobileBarTitle>
  );

  /* ‹ appears only when there is a screen underneath to pop to — a pipeline
     (lane 7) or the board list (lane 2). While the conversation IS the phone's
     leaf, the bar carries no back target rather than a dead one (§3.2: left is
     back, or nothing). */
  const canLeave = navState.stack.length > 1;

  const renderSheet: SheetRenderer = (name, close) => {
    if (name === "switch") {
      return (
        <MobileSwitchSheet
          title={displayName}
          entries={switchEntries}
          currentKey={resolvedKey}
          onPick={(entry) => { close(); switchTo(entry, true); }}
          onBoard={canLeave ? () => { close(); nav.back(); } : undefined}
          onProjects={canLeave || !shellHost ? undefined : () => nav.openSheet("projects")}
          onClose={close}
        />
      );
    }
    if (name === "menu" && activeFile && menuFace === "chat") {
      return (
        <MobileConversationMenu
          file={activeFile}
          stage={stage}
          crowned={Boolean(favoritesApi?.has(conversationIdentity(activeFile)))}
          hostTaskCount={hostTaskCount}
          pipelineCount={dockedPipelines.length}
          onOpenPipeline={dockedPipelines.length ? () => setPipelineSheetOpen(true) : undefined}
          onRename={() => setRenameToken((token) => token + 1)}
          onToggleCrown={favoritesApi ? () => favoritesApi.toggle(conversationIdentity(activeFile)) : undefined}
          onHandoff={onHandoff ? () => onHandoff(activeFile) : undefined}
          onOpenHost={() => nav.openSheet("host")}
          onOpenSearch={onOpenSearch}
          onOpenProjectMenu={renderBoardSheet ? () => setMenuFace("board") : undefined}
          projectName={displayName}
          onCloseCard={() => onClose(activeFile.path)}
          onReopen={() => onSelect(activeFile)}
          onClose={close}
        />
      );
    }
    return renderBoardSheet?.(name, close) ?? null;
  };

  const leaf = activeNode ? (
    /* One conversation, edge to edge under the bar: no pane header (the bar's
       title cell IS it), no strip, no docked tray — §3.4 spends 0 px here. */
    <div key={activeNode.file.path} data-testid="mobile-focused-pane" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <BranchPane
        file={activeNode.file}
        tasks={activeNode.tasks}
        isRoot={activeNode.isRoot}
        showFavorite
        onClose={() => onClose(activeNode.file.path)}
        relatedTasks={relatedTasksByPath.get(activeNode.file.path)}
        onOpenTask={openPipelineTask}
      />
      {/* The folded children (PR #441): the same 30 px bottom-up circles the
          desktop board carries, anchored to the pane's left edge and lifted
          above the composer. The overlay is pointer-events-none and reserves no
          height, so it costs the transcript nothing — but it is the phone's ONE
          route to a folded child, so it stays until the feed opens members
          itself (§3.4). The docked subagent TRAY, which did spend 44 px, is
          gone with the rest of this screen's chrome. */}
      <div
        data-testid="mobile-subagent-rail"
        className="pointer-events-none absolute bottom-20 left-2 z-[20]"
        style={{ width: 0, height: SUBAGENT_RAIL_H }}
      >
        <SubagentBadges
          conversationId={conversationIdentity(activeNode.file)}
          entries={files}
          cardRect={{ x: 0, y: 0, w: 0, h: SUBAGENT_RAIL_H }}
          onNavigate={(path) => {
            const target = files.find((item) => item.path === path);
            if (target) onSelect(target);
          }}
        />
      </div>
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
      /* No conversation yet, but an active pipeline is provisioning: its plan
         + controls ARE the surface here (issue #136 / review). */
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto">
        {dockedPipelines.map((pipeline) => (
          <MobilePipelineDock key={pipeline.id} pipeline={pipeline} flows={flows} files={files} renderablePaths={renderablePaths} renderableFlows={renderableFlows} linkedTasks={linkedTasksByPipeline.get(pipeline.id) ?? []} onOpenPath={openStagePath} onOpenFlow={openPipelineFlow} onOpenTask={openPipelineTask} />
        ))}
      </div>
    ) : (
      <div className="flex flex-1 items-center justify-center text-center text-body text-muted">{t("mobile.noConvos")}</div>
    )
  ) : (
    <div className="flex flex-1 items-center justify-center gap-2 text-center text-body text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {t("common.loading")}
    </div>
  );

  return (
    /* The chat shell root. It carries three contracts at once:

       - the swipe (§3.3) rides HERE, not on the bar itself: the bar belongs to
         the shell, and a touch that starts anywhere else — the feed above all —
         must keep its own scrolling (`inSwipeZone`);
       - the keyboard inset (#983): padding the on-screen keyboard's overlap
         away keeps the whole column inside the visible area, so the browser
         never scrolls the window to reach the focused field;
       - the chat-first budget (#419) and the 100dvh/overflow bounds (#440,
         #353), stamped on the DOM they govern. */
    <div
      data-testid="mobile-chat-shell"
      data-chat-min-share={MIN_TRANSCRIPT_SHARE}
      className="relative flex h-full max-h-[100dvh] min-h-0 min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden overflow-x-clip"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      <MobileShell
        screen={activeFile ? "chat" : "board"}
        screenId={activeFile ? conversationIdentity(activeFile) : undefined}
        title={title}
        titleLabel={activeFile ? t("mobile2.chat.switcher") : t("mobile2.bar.switchProject")}
        titleOpens={activeFile ? "switch" : shellHost ? "projects" : undefined}
        back={canLeave}
        host={shellHost}
        onOpenSearch={activeFile ? undefined : onOpenSearch}
        searchTestId="dash-search"
        renderSheet={renderSheet}
      >
        {alert}
        {leaf}
      </MobileShell>
      {/* Rename edits the title cell in place (§4.2, #1348): the editor lays
          over the bar, edge to edge, so the field owns the whole width instead
          of sharing a row with fixed controls. Mounted only after the menu's
          Rename row asks for it; once it closes, its idle face is hidden and
          takes no taps, so the bar underneath answers again. */}
      {renameToken > 0 && activeFile ? (
        <div
          data-testid="mobile-rename-slot"
          className="fixed inset-x-0 top-0 z-[55] h-[52px] pointer-events-none [&>[data-session-title-editor]]:pointer-events-auto [&>span:not([data-session-title-editor])]:hidden"
        >
          <SessionTitle
            key={activeFile.path}
            file={activeFile}
            autoEditToken={renameToken}
            alwaysVisible
            onTitleChange={(next) => setRenamed({ path: activeFile.path, title: next })}
          />
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
        <TaskSheet project={project} projectName={projectName} tasks={sheetTasks ?? tasks} files={files} initialView={taskSheet} onClose={() => setTaskSheet(null)} />
      ) : null}
    </div>
  );
}

/**
 * The bar's title cell for a conversation (§3.2, §4.2): the title on one line,
 * and under it the meta line — the dot, the state phrase, the engine mark, the
 * model and its reasoning tier, and `stage k/n` when this conversation is its
 * pipeline's current stage.
 *
 * The state phrase NEVER truncates; the model and the reasoning give way
 * first. That is the whole point of the line: a conversation blocked on the
 * operator must not read as a running one because its own word ran out of room
 * (2026-08 audit findings 3 and 4).
 */
export function ChatBarTitle({ file, offline, stage, bump, renamed = null }: { file: FileEntry; offline: boolean; stage: StagePosition | null; bump: "left" | "right" | null; renamed?: string | null }) {
  const { t } = useLocale();
  const bits = chatStateBits(t, file, { offline });
  const badge = engineBadge(file);
  const model = file.model
    ? file.effort ? t("mobile2.chat.identity", { model: file.model, effort: file.effort }) : file.model
    : badge.label;
  return (
    <span
      data-mobile2-chat-title
      className={`flex min-w-0 flex-1 flex-col justify-center transition-transform duration-[200ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
        bump === "right" ? "-translate-x-3" : bump === "left" ? "translate-x-3" : ""
      }`}
    >
      <span data-mobile2-title-text className="min-w-0 truncate text-title font-semibold leading-tight text-primary">
        {cleanTitle(renamed ?? file.title, 90)}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-label font-medium leading-tight text-secondary">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${CHAT_TONE_DOT[bits.tone]} ${bits.key === "working" ? "animate-pulse motion-reduce:animate-none" : ""}`} aria-hidden />
        <span data-mobile2-chat-state className={`shrink-0 whitespace-nowrap ${CHAT_TONE_TEXT[bits.tone]}`}>{bits.phrase}</span>
        {offline ? null : (
          <>
            <span aria-hidden className="shrink-0 text-muted">·</span>
            <ChatEngineMark file={file} />
            <span className="min-w-0 truncate" title={effortTitle(file)}>{model}</span>
            {stage?.current ? (
              <>
                <span aria-hidden className="shrink-0 text-muted">·</span>
                <span data-mobile2-chat-stage className="shrink-0 whitespace-nowrap tabular-nums">{t("mobile2.chat.stage", { k: stage.k, n: stage.n })}</span>
              </>
            ) : null}
          </>
        )}
      </span>
    </span>
  );
}
