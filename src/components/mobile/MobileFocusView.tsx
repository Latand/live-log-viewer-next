"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2 } from "@/components/icons";
import { TaskSheet, type TaskSheetView } from "@/components/tasks/TaskSheet";
import { taskRelationsByPath } from "@/components/tasks/taskRelations";
import { useBoardState } from "@/hooks/useBoardState";
import { useKeyboardInset } from "@/hooks/useComposer";
import { useNowSeconds } from "@/hooks/useNowSeconds";
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

import { compactPipelineLayoutFlows } from "@/components/pipelines/pipelineModel";
import { conversationIdentity } from "@/lib/accounts/identity";
import { useFavorites } from "@/components/favorites/FavoritesContext";
import { useOrchestratorSeat } from "@/components/orchestrator/useOrchestratorSeat";
import { useSeatPanel } from "@/components/orchestrator/useSeatPanel";
import { SessionTitle } from "@/components/session/SessionTitle";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { deckKey } from "@/components/scheme/agentLinks";
import { buildFocusFrameIndex, stageAnchorAliases } from "@/components/scheme/focusFrames";
import { buildSchemeLayout } from "@/components/scheme/layout";
import { subagentsOf } from "@/components/scheme/subagentBadgeModel";
import type { SubagentTrayApi } from "@/components/scheme/SubagentTrayView";

import { WakeupChip, wakeupChipKey } from "@/components/WakeupChip";

import { MobileBarTitle, MobileShell, useMobileShellChrome, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { MobileConversationMenu } from "./MobileConversationMenu";
import { MobileOrchestratorSheet } from "./MobileOrchestratorSheet";
import { MobileSwitchSheet, switchList, swipeTarget, type SwitchCandidate, type SwitchEntry } from "./MobileSwitchSheet";
import { CHAT_TONE_DOT, CHAT_TONE_TEXT, chatStateBits, stagePosition, type StagePosition } from "./mobileChatState";
import { topScreen, useMobileNav, useMobileNavStore } from "./mobileNav";

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
  /** Active project pipelines: they shape the layout's pipeline groups, and
      their count is the menu's pipeline row on a conversation that is no
      stage of any of them (the row then opens the pipelines list). */
  surfacePipelines?: Pipeline[];
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
  /* ── The shell (mobile v2 lane 3) ──────────────────────────────────────── */
  /** The Viewer's shell host: the attention badge, the arrival banner and the
      sheets it owns (the project switcher, the queue, search). Optional: when
      this screen is mounted inside the board's shell it inherits the host from
      it (`useMobileShellChrome`), so the board's call site plumbs it once. */
  shellHost?: MobileShellHost | null;
  /** The project board's own sheets — its `⋯` menu and the host sheet — for
      the sheet names this screen does not own. Inherited from the enclosing
      shell when the caller does not pass one. */
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
  /** Engine-native subagent tray surface (issue #142). The DOCKED tray is gone
      with the rest of this screen's chrome (§3.4 spends 0 px on it): folded
      children are reached from the subagent rail over the pane and from the
      feed. The prop stays in the contract because the board owns the tray for
      the desktop and hands the same object to every leaf. */
  trayApi?: SubagentTrayApi;
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
export function MobileFocusView({ project, projectName, groups, manual, files, flows, reviewGroups = [], pipelines, surfacePipelines = [], tasks, sheetTasks, drafts, favorites, isolatedManualPaths = EMPTY_PATHS, loaded, focus, onSelect, onClose, onDraftClose, onDraftSpawned, onConversationOpened, shellHost = null, renderBoardSheet, onOpenSearch, hostTaskCount = 0, onHandoff, alert }: Props) {
  const { t } = useLocale();
  /* The screen is mounted INSIDE the project board's shell (lane 2 pushes it
     when a conversation reaches the top of the stack), so the badge, the
     arrival banner and the board's own sheets are already one level up: this
     screen claims the chrome and reads them off the shell around it rather
     than having them threaded through the board's call site a second time.
     The explicit props still win, for a caller that mounts this screen alone. */
  const outerChrome = useMobileShellChrome();
  const host = shellHost ?? outerChrome?.host ?? null;
  const boardSheet = renderBoardSheet ?? outerChrome?.renderSheet;
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
     `project` (#1432): the old effect-based reset painted the previous
     project's pin (or the attention fallback) for one frame, mounted that
     pane's feed, then tore it down for the remembered one.
     The focus the parent NAMES outranks the remembered one at mount, for the
     same reason: on the phone this view is mounted by an open (mobile v2 lane
     2 pushes it as the conversation screen), so the remembered pin is the
     conversation the operator just left, and starting there painted and
     mounted that other conversation's feed for a frame. */
  const [focusState, setFocusState] = useState<{ project: string; key: string | null }>(() => ({ project, key: focus ?? rememberedFocus(project) }));
  if (focusState.project !== project) setFocusState({ project, key: focus ?? rememberedFocus(project) });
  const focusPath = focusState.key;
  const setFocusPath = useCallback((key: string | null) => setFocusState((prev) => (prev.key === key ? prev : { project: prev.project, key })), []);
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
  /* The focused conversation's spawned children, for the `⋯` menu's rows. The
     desktop reads the same model for its badges; the state a row shows moves
     with this clock, so a child that goes quiet leaves «working» without a
     rescan (issue #669). */
  const nowSeconds = useNowSeconds();
  const subagents = useMemo(
    () => (activeFile ? subagentsOf(conversationIdentity(activeFile), files, undefined, nowSeconds) : []),
    [activeFile, files, nowSeconds],
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
  /* Conversation-side relation strip (issue #292). */
  const relatedTasksByPath = useMemo(() => taskRelationsByPath(files, sheetTasks ?? tasks), [files, sheetTasks, tasks]);

  const openPipelineTask = useCallback((task: BoardTask) => setTaskSheet({ taskId: task.id }), []);

  /* Pin a pane the layout already holds, as the phone's OPEN gesture (#1244).
     A switcher row and a map/attention pick are the same deliberate act as
     clicking a card on the desktop board, so each one stamps the durable
     acknowledgement that releases a held finished outcome.

     What deliberately does NOT stamp: the bar/dock swipe and the attention
     fallback inside `resolvedKey`. Passing a card, or having it surface on
     its own, is not reading it. */
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
  const seatRead = useOrchestratorSeat(project, projectCwd || undefined);
  const seatStatus = seatRead.status;
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
     IS the top: this screen also renders while the board's own leaf is loading,
     and there the bottom of the stack is the board and stays that way. */
  const switchTo = useCallback((entry: SwitchEntry, stampSeen: boolean) => {
    if (stampSeen) openEntry(entry.key);
    else setFocusPath(entry.key);
    /* The stack names a conversation by the BOARD KEY, the same one the board's
       own open pushes (lane 2): the project route reads that id back as the
       conversation to show, so a sibling switch and an open have to name the
       screen identically or the replace would land on a screen nothing pins.
       `entry.id` is the durable identity the row and the screen are STAMPED
       with, which is a different question. */
    if (topScreen(navState).kind === "chat") nav.replace({ kind: "chat", id: entry.key });
  }, [openEntry, setFocusPath, nav, navState]);

  /* Which switcher row is on screen — a conversation, a review-round deck or a
     draft. EVERY leaf the switcher can reach is one of these, so the bar's
     title cell, the swipe and the screen's identity are driven from HERE and
     not from `activeFile`: a deck or a draft has no transcript, and reading
     the cell off the file made those two leaves dead ends that showed the
     project's name and could not be left by the gesture that reached them. */
  const activeEntry = useMemo(
    () => switchEntries.find((entry) => entry.key === resolvedKey) ?? null,
    [switchEntries, resolvedKey],
  );

  /* The seat sheet over this conversation (§4.2, §4.5): the `⋯`'s first-group
     «Orchestrator seat» row is the phone's only route to the seat's status,
     mandate and rotation now that the pinned row went with the strip. */
  const [seatSheetOpen, setSeatSheetOpen] = useState(false);
  const [seatHandoff, setSeatHandoff] = useState(false);
  const holdsSeat = resolvedKey !== null && seatKey !== null && resolvedKey === seatKey;
  const seatPanel = useSeatPanel({ project, files, seat: seatRead, holdsSeat, open: seatSheetOpen });
  /* A rotation confirmed from here lands in the SUCCESSOR: the incumbent stays
     live under the draft for as long as the rotation takes, so the phone waits
     for the seat read to name a conversation other than this one — and for the
     files feed to actually carry it, since pinning a key the layout has not
     got yet would land nowhere. */
  useEffect(() => {
    if (!seatHandoff || !seatKey || seatKey === resolvedKey || !byKey.has(seatKey)) return;
    setSeatSheetOpen(false);
    setSeatHandoff(false);
    setFocusPath(seatKey);
  }, [seatHandoff, seatKey, resolvedKey, byKey, setFocusPath]);
  /* And it is armed for THAT rotation only. A rotation that failed, or a draft
     the operator abandoned, closes the sheet without a successor; leaving the
     wait armed would hand the phone's focus to whatever seat change happened
     next, on another surface, minutes later and unasked. */
  useEffect(() => {
    if (!seatSheetOpen && seatHandoff) setSeatHandoff(false);
  }, [seatSheetOpen, seatHandoff]);

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
    if (!start || !touch || !activeEntry || navState.sheet) return;
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
  ) : activeEntry ? (
    /* A deck or a draft names itself exactly as its switcher row does, so the
       cell the operator taps to leave says the same thing as the row that
       brought them here. */
    <EntryBarTitle entry={activeEntry} offline={offline} bump={bumpPulse?.side ?? null} />
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
          onProjects={canLeave || !host ? undefined : () => nav.openSheet("projects")}
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
          pipelineCount={surfacePipelines.length}
          onOpenSeat={seatPanel ? () => setSeatSheetOpen(true) : undefined}
          /* P2-9 (§4.2): a stage conversation opens ITS pipeline's screen, and
             ‹ from there returns here; a conversation that is no stage opens
             the pipelines list. Both are screens on the stack the board owns
             (lane 7), so the dock sheet this row used to open is retired. */
          onOpenPipeline={stage
            ? () => nav.push({ kind: "pipeline", id: stage.pipeline.id })
            : surfacePipelines.length ? () => nav.push({ kind: "pipelines" }) : undefined}
          onRename={() => setRenameToken((token) => token + 1)}
          onToggleCrown={favoritesApi ? () => favoritesApi.toggle(conversationIdentity(activeFile)) : undefined}
          onHandoff={onHandoff ? () => onHandoff(activeFile) : undefined}
          onOpenHost={() => nav.openSheet("host")}
          subagents={subagents}
          onOpenSubagent={(path) => {
            const target = files.find((item) => item.path === path);
            if (target) onSelect(target);
          }}
          onOpenSearch={onOpenSearch}
          onOpenProjectMenu={boardSheet ? () => setMenuFace("board") : undefined}
          projectName={displayName}
          onCloseCard={() => onClose(activeFile.path)}
          onReopen={() => onSelect(activeFile)}
          onClose={close}
        />
      );
    }
    return boardSheet?.(name, close) ?? null;
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
      {/* No badge rail and no docked tray over the feed (README §3.4, §6):
          the desktop scheme's badges are laid out from a card rect the phone
          does not have, so mounted here they floated down the feed's left edge
          over the prose (#1439). The children are rows in the `⋯` menu instead
          — `subagents`, below — so the transcript keeps its full width. */}
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
    /* Nothing to show. The board is the phone's leaf for that (lane 2), and a
       provisioning pipeline is a row there with a screen behind it (lane 7);
       the dock that used to fill this branch went with lane 10. */
    <div className="flex flex-1 items-center justify-center text-center text-body text-muted">{t("mobile.noConvos")}</div>
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
        screen={activeEntry ? "chat" : "board"}
        screenId={activeEntry?.id}
        title={title}
        titleLabel={activeEntry ? t("mobile2.chat.switcher") : t("mobile2.bar.switchProject")}
        titleOpens={activeEntry ? "switch" : host ? "projects" : undefined}
        back={canLeave}
        host={host}
        onOpenSearch={activeEntry ? undefined : onOpenSearch}
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

      {/* The seat sheet (§4.5), over this conversation. It is the SAME sheet the
          board's seat card opens — one seat surface, never a second one — fed
          by `useSeatPanel`, which answers only for a live seat this
          conversation holds. */}
      {seatSheetOpen && seatPanel ? (
        <MobileOrchestratorSheet
          project={project}
          projectName={displayName}
          projectCwd={projectCwd || undefined}
          /* The rotate draft is the fullscreen surface and the seat's reading
             is the bottom sheet (§4.5); the flow's own `open` is what says
             which of the two this conversation is showing. */
          sheet={seatPanel.rotate.open ? "rotate" : "seat"}
          now={nowSeconds}
          state={seatPanel.state}
          status={seatPanel.status}
          file={seatPanel.file}
          incumbent={seatPanel.incumbent}
          pendingMandate={seatPanel.pendingMandate}
          viewerMcpRegistered={seatPanel.viewerMcpRegistered}
          submitting={false}
          rotate={{ ...seatPanel.rotate, onConfirm: (input) => { setSeatHandoff(true); seatPanel.rotate.onConfirm(input); } }}
          /* Create and resume belong to the surface that exists without a seat
             conversation; over a LIVE seat the sheet's primary action is «Open
             conversation», so this confirm has no control that can call it. */
          onConfirm={() => undefined}
          onRecheck={seatPanel.onRecheck}
          /* Already in it: the sheet was opened FROM the seat's conversation. */
          onOpenConversation={() => setSeatSheetOpen(false)}
          onClose={() => setSeatSheetOpen(false)}
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
        {/* The pending self-wake (#165). Its standing contract is that it shows
            on EVERY surface, the phone included, because a conversation that
            reads as idle is actually sleeping until a known time — and the
            phone's pane header, which used to carry it, is gone. It rides the
            state line rather than a row of its own, so it costs the transcript
            nothing, and it is passive here: the cell around it is already the
            switcher's button, and a button inside a button is not a control
            anyone can reach. */}
        {file.pendingWakeup ? (
          <WakeupChip key={wakeupChipKey(file.pendingWakeup)} wakeup={file.pendingWakeup} interactive={false} className="ml-0.5" />
        ) : null}
      </span>
    </span>
  );
}

/**
 * The bar's title cell for the two leaves that carry no transcript: a
 * review-round deck and a not-yet-spawned draft (README §3.2).
 *
 * It says exactly what the switcher row for the same key says — the deck names
 * the work it reviews and takes its state from its newest round, the draft says
 * it has not been sent — so the cell an operator taps to LEAVE names the same
 * thing as the row that brought them here. Without it these two leaves showed
 * the project's name and opened the project switcher, which is a different
 * screen's cell on this one's bar.
 */
export function EntryBarTitle({ entry, offline, bump }: { entry: SwitchEntry; offline: boolean; bump: "left" | "right" | null }) {
  const { t } = useLocale();
  const bits = entry.file ? chatStateBits(t, entry.file, { offline }) : null;
  return (
    <span
      data-mobile2-chat-title
      data-mobile2-entry={entry.section}
      className={`flex min-w-0 flex-1 flex-col justify-center transition-transform duration-[200ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
        bump === "right" ? "-translate-x-3" : bump === "left" ? "translate-x-3" : ""
      }`}
    >
      <span data-mobile2-title-text className="min-w-0 truncate text-title font-semibold leading-tight text-primary">
        {entry.label}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-label font-medium leading-tight text-secondary">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bits ? CHAT_TONE_DOT[bits.tone] : "bg-strong"}`} aria-hidden />
        {bits ? (
          <span data-mobile2-chat-state className={`shrink-0 whitespace-nowrap ${CHAT_TONE_TEXT[bits.tone]}`}>{bits.phrase}</span>
        ) : (
          <span data-mobile2-chat-state className="min-w-0 truncate">{entry.meta}</span>
        )}
        {/* The same standing contract as the conversation's own cell (#165). */}
        {entry.file?.pendingWakeup ? (
          <WakeupChip key={wakeupChipKey(entry.file.pendingWakeup)} wakeup={entry.file.pendingWakeup} interactive={false} className="ml-0.5" />
        ) : null}
      </span>
    </span>
  );
}
