"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { selectionInOrder, viewBus } from "@/hooks/viewPresenceBus";
import { conversationIdentity, formatConversationHash } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { admissionSnapshot, type SeatRefs } from "@/lib/tasks/groupHide";
import type { BoardTask, TaskColor, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";
import { compactPipelineLayoutFlows, latestAttempt, stagePromptExtra } from "@/components/pipelines/pipelineModel";
import type { BranchGroup } from "@/components/projectModel";
import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { reconcileLayoutNodes } from "@/components/scheme/layoutIdentity";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { isPlacedTask } from "@/components/scheme/taskGeometry";
import { updateTask } from "@/components/tasks/taskApi";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { useOrchestratorSeat, type OrchestratorSeatRead } from "@/components/orchestrator/useOrchestratorSeat";
import { cleanTitle } from "@/components/utils";
import { canHandoff } from "@/components/HandoffHandle";

import { AccountChoiceContext, ConversationAccountPopover, StageAccountPopover, useAccountChoices, type AccountTarget } from "./AccountPicker";
import { HiddenTray } from "./HiddenTray";
import { KanbanDraftContext, KanbanTaskComposer, type KanbanDraftActions } from "./KanbanDrafts";
import { KanbanCard, resurfaceText, statusLabel, TASK_COLOR_HEX } from "./KanbanCard";
import { MoreGlyph } from "./kanbanGlyphs";
import { buildKanbanModel, KANBAN_STATUSES, type KanbanCard as KanbanCardModel, type KanbanModel } from "./kanbanModel";
import { KanbanMenu, KanbanPopover, useOverlay, type KanbanMenuItem } from "./kanbanMenus";
import { KanbanReceipts, useReceipts } from "./KanbanReceipts";
import { useTaskMutations, type FieldEditOutcome, type StatusMoveOutcome, type TaskMutationPorts } from "./useTaskMutations";
import { assignmentRefFor, browserAssignmentPorts, type AssignmentPorts } from "./kanbanAssignments";
import { allCards, cardAnchors, cardOnScreen, conversationOwners, cssEscape, kanbanFocusIndex, readerArrived } from "./kanbanFocus";
import { closeReader, foldReader, followPaths, openReader, ReaderMemory, type OpenReader } from "./readerMemory";
import { ReaderPlacement, ReaderPortals, ReaderSlot, StopHostConfirm, type ReaderOwner, type ReaderStop, type ReaderView } from "./KanbanReaders";
import { stagePanelKey } from "./KanbanCard";
import { operationalAttempts } from "./pipelineGraph";
import { browserPipelinePorts, type PipelinePorts } from "./pipelinePorts";
import { stageNames } from "./PipelineSection";
import { stageDraftKey, StageDrafts } from "./stageDrafts";
import { StagesSheet, type SheetPane } from "./StagesSheet";
import { currentStageId, draftOutcome, pipelineActionOptions, shownAttempt, stageDraftable, stageNotStarted, type PipelineActionOption } from "./stagesModel";
import { usePipelineActions } from "./usePipelineActions";

/**
 * The desktop kanban board (#1695 K2): the approved prototype's columns and
 * cards over the project's complete task inventory.
 *
 * Cards come from the same band projection the scheme board draws
 * (`buildSchemeLayout` → `buildTaskBands`, same inputs), so identity and
 * grouping never differ between the two boards while both exist. Status moves
 * are optimistic and revision-guarded (`useTaskMutations`); every other write
 * this slice offers goes through an existing route.
 *
 * K4b: a card's title, description and colour are edited in place, and a task
 * group is hidden with `×`, its menu, `H` or a column's bulk hide, each with
 * one Undo. All of them ride the same guarded queue. The Hidden tray lists
 * every group, empty task and closed conversation the board is not drawing,
 * and a hidden group that needs the operator again comes back with its reason.
 */

export type KanbanLayoutMode = "wide" | "narrow" | "scroll" | "tabs";

/** Prototype `layoutMode`, measured on the board's own width. Below 768 px the
    desktop board is tabbed; the phone layout starts below 640 px and never
    mounts this component. */
export function kanbanLayoutMode(width: number): KanbanLayoutMode {
  if (width >= 1400) return "wide";
  if (width >= 1200) return "narrow";
  if (width >= 768) return "scroll";
  return "tabs";
}

export interface KanbanBoardProps {
  project: string;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  reviewGroups?: Flow[];
  pipelines: Pipeline[];
  surfacePipelines?: Pipeline[];
  /** Placed tasks, for the layout pass exactly as the scheme receives them. */
  tasks: readonly BoardTask[];
  /** Every stored task of the project. */
  allTasks: readonly BoardTask[];
  drafts: string[];
  favorites?: ReadonlySet<string>;
  isolatedManualPaths?: ReadonlySet<string>;
  draftBands?: ReadonlyMap<string, string>;
  /** Board clock, epoch seconds. */
  now: number;
  loaded: boolean;
  catalogFailures: number;
  selection: ReadonlySet<string>;
  viewSwitch?: ReactNode;
  /** The orchestrator seat above the columns (#1695 K3), given the id of the
      board region its skip link lands on. */
  seat?: (boardId: string, seatRead: OrchestratorSeatRead | null) => ReactNode;
  /** A conversation or task the Viewer was asked to open while this board
      shows: its card is revealed, and a conversation opens as a reader. */
  focus?: string | null;
  /** A reader opened: the same seen-stamp opening a conversation leaves. */
  onConversationOpened?: (path: string) => void;
  /** Conversations, the project's every conversation: for what no card draws (review decks, collapsed workers)
      and conversations this board's files do not carry. */
  onOpenConversations: () => void;
  /** «+ Agent» in the bar: a draft on a card of its own, a task in the making (K9a). */
  onNewAgent?: () => void;
  /** «+ Agent» on a card: a draft in that card, seeded with its task's text. */
  onAddAgent?: (band: { id: string; task: BoardTask | null; title: string }) => void;
  /** A draft closed from its pane. */
  onDraftClose?: (id: string) => void;
  /** A draft's launch started its conversation. */
  onDraftSpawned?: (id: string, file: FileEntry) => void;
  /** Hand a conversation to a new agent: a draft on the card that holds it. */
  onHandoff?: (file: FileEntry, cardId: string | null) => void;
  /** Retry a failed launch from its conversation's feed: a draft prefilled from the launch. */
  onSpawnRetry?: (file: FileEntry) => void;
  /** Take a conversation off the board (the `hidden` board preference); Hidden lists it with Restore. */
  onCloseConversation?: (file: FileEntry) => void;
  /** Conversations closed on this project's board (the `hidden` board
      preference); the Hidden tray lists the ones this board carries. */
  closedPaths?: readonly string[];
  /** Restore a closed conversation to the board. */
  onRestoreConversation?: (file: FileEntry) => void;
  /** The project's checkout, for the orchestrator seat read. */
  projectCwd?: string;
  /** The project's seat as a caller already knows it; read from the seat
      route when absent. */
  seatRefs?: SeatRefs | null;
  mutationPorts?: TaskMutationPorts;
  assignmentPorts?: AssignmentPorts;
  /** Where open readers are remembered; this browser's storage by default. */
  /** Shared geometry from the dashboard; standalone consumers derive it here. */
  layout?: SchemeLayout;
  readerStorage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** The pipeline routes; the browser's own by default. */
  pipelinePorts?: PipelinePorts;
}

/** A waiting stage open on a card: its first message, before it has a conversation. */
interface StagePanel {
  cardId: string;
  pipelineId: string;
  stageId: string;
  folded: boolean;
}

/** The Stages sheet: which card's pipeline, the stage it opened on, and what to hand focus back to. */
interface SheetTarget {
  cardId: string;
  pipelineId: string;
  focus: string | null;
  opener: HTMLElement | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_FLOWS: Flow[] = [];
const EMPTY_PIPELINES: Pipeline[] = [];
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();
const NO_READERS: readonly OpenReader[] = [];
const NO_CREATED: ReadonlyArray<{ task: BoardTask; basis: readonly BoardTask[] }> = [];

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether search leaves this card on the board. */
function cardMatchesShown(model: KanbanModel, card: KanbanCardModel): boolean {
  return model.columns[card.status].shown.some((shown) => shown.id === card.id) || model.unlinkedShown.some((shown) => shown.id === card.id);
}

type EditField = "title" | "description";

/** The title (first line) or description (the rest) of a task's text. */
function textField(text: string, field: EditField): string {
  const newline = text.search(/\r?\n/);
  if (field === "title") return (newline < 0 ? text : text.slice(0, newline)).trim();
  return newline < 0 ? "" : text.slice(newline).trim();
}

/** The task's text with one of its fields replaced, the other kept byte for byte. */
function withField(text: string, field: EditField, value: string): string {
  const newline = text.search(/\r?\n/);
  if (field === "title") return newline < 0 ? value : value + text.slice(newline);
  const first = newline < 0 ? text : text.slice(0, newline);
  return value ? `${first}\n${value}` : first;
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): ReadonlyMap<string, V> {
  if (value === undefined && !map.has(key)) return map;
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

const NO_EDITS: ReadonlyMap<string, never> = new Map<string, never>();

/** Presence measurement cadence while the operator is scrolling (#1546). The
    scan reads every card's rect, so it runs at most this often during a gesture
    and once more after it settles; presence is exact at rest and at worst one
    window behind while the board is moving. */
const SCROLL_MEASURE_MS = 100;
const SCROLL_SETTLE_MS = 120;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useBands(props: KanbanBoardProps) {
  const { t } = useLocale();
  const { groups, manual, files, flows, reviewGroups = EMPTY_FLOWS, pipelines, surfacePipelines = EMPTY_PIPELINES, tasks, allTasks, drafts, favorites = EMPTY_SET, isolatedManualPaths = EMPTY_SET, draftBands = EMPTY_MAP, now, project } = props;
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  const placedTasks = useMemo(() => tasks.filter(isPlacedTask), [tasks]);
  const previousLayout = useRef<SchemeLayout | null>(null);
  const layout = useMemo(() => {
    const built = reconcileLayoutNodes(
      previousLayout.current,
      props.layout ?? buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, EMPTY_SET, { now }),
    );
    previousLayout.current = built;
    return built;
  }, [props.layout, groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, now]);
  const projection = useMemo(() => projectTaskWorkflows([...allTasks], pipelines, flows, files, project), [allTasks, pipelines, flows, files, project]);
  const bands = useMemo(
    () => buildTaskBands(layout, { tasks: allTasks, projection, draftBands, untitled: t("bands.untitled"), reviewFlow: t("bands.reviewFlow") }),
    [layout, allTasks, projection, draftBands, t],
  );
  return { bands, projection };
}

export function KanbanBoard(props: KanbanBoardProps) {
  const { t } = useLocale();
  const { project, allTasks: storedTasks, pipelines, files, loaded, catalogFailures, selection, onOpenConversations, onConversationOpened } = props;
  /* `+ Task` (K9a): a task this board created is drawn at once, on the tasks it was created against. The next
     tasks payload is the authority: it carries the task, or the task is gone (deleted, moved to another project)
     and so is its card. */
  const [createdTasks, setCreatedTasks] = useState<ReadonlyArray<{ task: BoardTask; basis: readonly BoardTask[] }>>(NO_CREATED);
  const allTasks = useMemo(() => {
    const fresh = createdTasks
      .filter((entry) => entry.basis === storedTasks && entry.task.project === project && !storedTasks.some((stored) => stored.id === entry.task.id))
      .map((entry) => entry.task);
    return fresh.length ? [...storedTasks, ...fresh] : storedTasks;
  }, [createdTasks, storedTasks, project]);
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- a newer payload retires what was drawn ahead of it */
    setCreatedTasks((current) => (current.some((entry) => entry.basis !== storedTasks) ? current.filter((entry) => entry.basis === storedTasks) : current));
  }, [storedTasks]);
  const storedTasksRef = useRef(storedTasks);
  storedTasksRef.current = storedTasks;
  const [composingTask, setComposingTask] = useState(false);
  const assignments = props.assignmentPorts ?? browserAssignmentPorts;
  const boardId = `kb-board-${useId().replace(/:/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<KanbanLayoutMode>("wide");
  const [tab, setTab] = useState<TaskStatus>("assigned");
  const [query, setQuery] = useState("");
  const [linkQuery, setLinkQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [dragHint, setDragHint] = useState(false);
  const menu = useOverlay<
    { kind: "status" | "card" | "colour"; cardId: string } | { kind: "column"; status: TaskStatus } | { kind: "tray" } | { kind: "reader"; key: string; stop: ReaderStop } | { kind: "link"; key: string } | { kind: "stop"; key: string }
    | { kind: "pipeline"; cardId: string; pipelineId: string } | { kind: "stage"; cardId: string; pipelineId: string; stageId: string; from: "sheet" | "panel" }
    | { kind: "account"; target: AccountTarget }
  >();
  const { receipts, show, dismiss } = useReceipts();
  const latestUndo = useRef<{ receiptId: number; run: () => void } | null>(null);
  /* `U` undoes only what a receipt on screen still offers: once that receipt
     closes, by its timer or by hand, the undo it carried is gone with it. */
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;
  useEffect(() => {
    if (latestUndo.current && !receipts.some((receipt) => receipt.id === latestUndo.current!.receiptId)) latestUndo.current = null;
  }, [receipts]);

  const { controller, statuses, edits } = useTaskMutations(allTasks, props.mutationPorts);
  /* Which cards show a pipeline's graph or its summary, as the operator chose. */
  const [graphChoices, setGraphChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleGraph = useCallback((cardId: string, pipelineId: string, open: boolean) => {
    setGraphChoices((current) => new Map(current).set(`${cardId}|${pipelineId}`, open));
  }, []);
  /* K5b: pipeline actions, waiting stages' first messages, and the Stages sheet. */
  const pipelinePorts = props.pipelinePorts ?? browserPipelinePorts;
  const [stageDrafts] = useState(() => new StageDrafts());
  const draftsVersion = useSyncExternalStore(stageDrafts.subscribe, stageDrafts.version, stageDrafts.version);
  const [stagePanels, setStagePanels] = useState<ReadonlyMap<string, StagePanel>>(() => new Map());
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  /* Pane folds and attempt choices outlive one opening of the sheet, as the prototype's do. */
  const [paneFolds, setPaneFolds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [paneAttempts, setPaneAttempts] = useState<ReadonlyMap<string, number>>(() => new Map());
  /* The board draws the edits it has sent ahead of the poll: a new title or
     colour at once, and a hidden group gone at once with a hide stamped now. */
  const hideStamps = useRef(new Map<string, string>());
  const effectiveTasks = useMemo(() => {
    if (!edits.size) {
      hideStamps.current.clear();
      return allTasks;
    }
    return allTasks.map((task) => {
      const edit = edits.get(task.id);
      if (!edit) {
        hideStamps.current.delete(task.id);
        return task;
      }
      const next: BoardTask = { ...task };
      if ("color" in edit) {
        if (edit.color) next.color = edit.color;
        else delete next.color;
      }
      if (edit.hide === true) {
        let at = hideStamps.current.get(task.id);
        if (!at) hideStamps.current.set(task.id, (at = new Date().toISOString()));
        next.groupHidden = { at, by: "operator", admitted: admissionSnapshot(task.assignments) };
      } else {
        hideStamps.current.delete(task.id);
        if (edit.hide === false) delete next.groupHidden;
      }
      if (typeof edit.text === "string") {
        next.text = edit.text;
        if (next.origin?.refinement === "pending") next.origin = { ...next.origin, refinement: "titled" };
      }
      return next;
    });
  }, [allTasks, edits]);
  const { bands, projection } = useBands({ ...props, allTasks: effectiveTasks });
  /* The seat as its route reports it, active and pending. While it is unknown
     the board guesses nothing: the × stays, and the server decides. This is
     the page's one read of the seat: the orchestrator panel above the columns
     is handed the same read and polls nothing of its own. */
  const seatRead = useOrchestratorSeat(props.seatRefs === undefined ? project : null, props.projectCwd);
  const seatKey = props.seatRefs !== undefined
    ? (props.seatRefs ? JSON.stringify(props.seatRefs) : "")
    : (seatRead.status ? JSON.stringify([seatRead.status.seat, seatRead.status.pending].map((seat) => [seat?.conversationId ?? null, seat?.path ?? null])) : "");
  const seatRefs = useMemo<SeatRefs | null>(() => {
    if (props.seatRefs !== undefined) return props.seatRefs;
    const status = seatRead.status;
    if (!status) return null;
    const seats = [status.seat, status.pending];
    return {
      conversationIds: seats.flatMap((seat) => (seat?.conversationId ? [seat.conversationId] : [])),
      paths: seats.flatMap((seat) => (seat?.path ? [seat.path] : [])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what the seat names
  }, [seatKey]);
  /* The model's own clock moves in 15 s steps: it only phrases ages and
     waits, and a per-second clock would rebuild every card each tick. */
  const modelNow = Math.floor(props.now / 15) * 15;
  const model: KanbanModel = useMemo(
    () => buildKanbanModel({ bands, tasks: effectiveTasks, pipelines, projection, files, flows: props.flows, statusOverrides: statuses, seat: seatRefs, query, now: modelNow }),
    [bands, effectiveTasks, pipelines, projection, files, props.flows, statuses, seatRefs, query, modelNow],
  );
  const cardsById = useMemo(() => {
    const map = new Map<string, KanbanCardModel>();
    for (const status of KANBAN_STATUSES) for (const card of model.columns[status].cards) map.set(card.id, card);
    for (const card of model.unlinked) map.set(card.id, card);
    return map;
  }, [model]);
  const tasksById = useRef(new Map<string, BoardTask>());
  tasksById.current = new Map(allTasks.map((task) => [task.id, task] as const));
  const effectiveById = useRef(new Map<string, BoardTask>());
  effectiveById.current = new Map(effectiveTasks.map((task) => [task.id, task] as const));
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);

  /* ── Readers: conversations open inside cards ────────────────────────── */
  const cards = useMemo(() => allCards(model), [model]);
  const owners = useMemo(() => conversationOwners(cards, files), [cards, files]);
  const anchors = useMemo(() => cardAnchors(cards, owners), [cards, owners]);
  const readerStorage = props.readerStorage === undefined ? browserStorage() : props.readerStorage;
  const memory = useMemo(() => new ReaderMemory(project, readerStorage), [project, readerStorage]);
  const openReaders = useSyncExternalStore(memory.subscribe, memory.snapshot, () => NO_READERS);
  const openReadersRef = useRef(openReaders);
  openReadersRef.current = openReaders;
  const [placement] = useState(() => new ReaderPlacement());
  /* One reader at a time may take the whole window; it is the same reader,
     moved, and goes back into its card when it leaves. */
  const [fullReader, setFullReader] = useState<string | null>(null);
  /* A conversation no card holds (a review round in a deck, a collapsed worker, an engine's subagent) opens as a
     reader of its own, in the whole window: the same transcript and composer, for as long as it is open. It is
     not remembered, nothing is written to the board, and it belongs to the project it was opened in: a board kept
     mounted across a project switch never shows it over another project. */
  const [looseReader, setLooseReader] = useState<{ key: string; path: string; project: string } | null>(null);
  const loose = looseReader?.project === project ? looseReader : null;
  const looseRef = useRef(loose);
  looseRef.current = loose;
  const toggleFull = useCallback((key: string) => setFullReader((current) => (current === key ? null : key)), []);
  /* The window is the loose reader's only place: leaving it, or its project, closes the reader. */
  useEffect(() => {
    if (!looseReader) return;
    if (looseReader.project !== project) {
      setLooseReader(null);
      setFullReader((current) => (current === looseReader.key ? null : current));
    } else if (fullReader !== looseReader.key) {
      setLooseReader(null);
    }
  }, [fullReader, looseReader, project]);
  /* Going anywhere else on the board leaves the loose reader's window first, so it never stays over the card,
     reader or pipeline the operator went to. */
  const leaveLoose = useCallback((keep: string | null) => {
    const current = looseRef.current;
    if (!current || current.key === keep) return;
    setLooseReader(null);
    setFullReader((full) => (full === current.key ? null : full));
  }, []);
  /* Escape puts it back, unless the key belongs to a field or an open menu.
     Listened for on the document: the reader is a portal, so its key events
     never pass through the overlay in React's tree. */
  useEffect(() => {
    if (!fullReader) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      setFullReader(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullReader]);
  const parkRef = useCallback((park: HTMLDivElement | null) => placement.setPark(park), [placement]);
  const filesByIdentity = useMemo(() => new Map(files.map((file) => [conversationIdentity(file), file] as const)), [files]);
  /* A conversation that has left this board's files keeps its reader mounted
     on the file it was last seen as, so nothing typed into it is lost. */
  const lastSeenFiles = useRef(new Map<string, FileEntry>());

  /* ── The Stages sheet's panes ─────────────────────────────────────────── */
  const filesByConversation = useMemo(() => new Map(files.filter((file) => file.conversationId).map((file) => [file.conversationId!, file] as const)), [files]);
  /* The card's pipeline, or the same pipeline on whichever card holds it now. */
  const sheetSummary = useMemo(() => {
    if (!sheet) return null;
    const own = cardsById.get(sheet.cardId)?.pipelines.find((entry) => entry.pipeline.id === sheet.pipelineId);
    if (own) return { card: cardsById.get(sheet.cardId)!, summary: own };
    for (const card of cards) {
      const summary = card.pipelines.find((entry) => entry.pipeline.id === sheet.pipelineId);
      if (summary) return { card, summary };
    }
    return null;
  }, [sheet, cardsById, cards]);
  const sheetPanes = useMemo<SheetPane[]>(() => {
    if (!sheetSummary) return [];
    const { pipeline } = sheetSummary.summary;
    return pipeline.stages.map((stage) => {
      const key = stageDraftKey(pipeline.id, stage.id);
      const folded = paneFolds.has(key);
      const shown = shownAttempt(pipeline, stage.id, paneAttempts.get(key) ?? null);
      const file = shown ? (shown.agentPath ? filesByPath.get(shown.agentPath) : undefined) ?? (shown.conversationId ? filesByConversation.get(shown.conversationId) : undefined) ?? null : null;
      return { stage, folded, attempts: operationalAttempts(pipeline, stage.id), shown, file, readerKey: file && !folded ? conversationIdentity(file) : null };
    });
  }, [sheetSummary, paneFolds, paneAttempts, filesByPath, filesByConversation]);
  /* A conversation a pane shows is mounted in that pane, unless it has the window. */
  const sheetSlots = useMemo(() => new Set(sheetPanes.flatMap((pane) => (pane.readerKey && pane.readerKey !== fullReader ? [pane.readerKey] : []))), [sheetPanes, fullReader]);

  /* A reader's owner is rebuilt with the model; while it names the same card, title and stage, the reader keeps
     the object it had, so a model rebuild does not re-render every open reader. */
  const ownerCache = useRef(new Map<string, ReaderOwner>());
  const stableOwner = (key: string, next: ReaderOwner): ReaderOwner => {
    const previous = ownerCache.current.get(key);
    if (previous && previous.cardId === next.cardId && previous.cardTitle === next.cardTitle
      && previous.stage?.pipeline === next.stage?.pipeline && previous.stage?.stage === next.stage?.stage) return previous;
    ownerCache.current.set(key, next);
    return next;
  };
  const readerViews = useMemo<ReaderView[]>(() => {
    const views: ReaderView[] = openReaders.flatMap((reader) => {
      const owner = owners.get(reader.key);
      const file = owner?.file ?? filesByIdentity.get(reader.key) ?? filesByPath.get(reader.path) ?? lastSeenFiles.current.get(reader.key);
      if (!file) return [];
      const card = owner ? cardsById.get(owner.cardId) : undefined;
      const inSheet = sheetSlots.has(reader.key);
      return [{
        readerKey: reader.key,
        file,
        folded: reader.folded && fullReader !== reader.key && !inSheet,
        full: fullReader === reader.key,
        inSheet,
        owner: owner && card ? stableOwner(reader.key, { cardId: card.id, cardTitle: card.titlePending ? t("kanban.untitled") : card.title, stage: owner.stage }) : null,
      }];
    });
    if (loose && !views.some((view) => view.readerKey === loose.key)) {
      const file = filesByIdentity.get(loose.key) ?? filesByPath.get(loose.path) ?? lastSeenFiles.current.get(loose.key);
      if (file) views.push({ readerKey: loose.key, file, folded: false, full: true, owner: null });
    }
    /* A pane's conversation no card has open is mounted for as long as the pane shows it. */
    if (sheetSummary) {
      const open = new Set(openReaders.map((reader) => reader.key));
      const { card, summary } = sheetSummary;
      for (const pane of sheetPanes) {
        if (!pane.readerKey || !pane.file || open.has(pane.readerKey)) continue;
        views.push({
          readerKey: pane.readerKey,
          file: pane.file,
          folded: false,
          full: fullReader === pane.readerKey,
          inSheet: fullReader !== pane.readerKey,
          owner: stableOwner(pane.readerKey, { cardId: card.id, cardTitle: card.titlePending ? t("kanban.untitled") : card.title, stage: { pipeline: summary.pipeline, stage: pane.stage } }),
        });
      }
    }
    return views;
  }, [openReaders, owners, filesByIdentity, filesByPath, cardsById, t, fullReader, loose, sheetSlots, sheetSummary, sheetPanes]);
  useEffect(() => {
    for (const view of readerViews) lastSeenFiles.current.set(view.readerKey, view.file);
  }, [readerViews]);
  /* A write this browser refused leaves every reader open on this page; the
     operator is told once that they will not come back after a reload. */
  const toldUnremembered = useRef(false);
  useEffect(() => {
    if (memory.persisted()) {
      toldUnremembered.current = false;
      return;
    }
    if (toldUnremembered.current) return;
    toldUnremembered.current = true;
    show(t("kanban.readersNotRemembered", { count: openReaders.length }), undefined, { error: true });
  }, [memory, openReaders, show, t]);
  /* A conversation that moved to a new transcript keeps its reader. */
  useEffect(() => {
    memory.update((readers) => followPaths(readers, (key) => filesByIdentity.get(key)?.path ?? null));
  }, [memory, filesByIdentity]);
  const readerKeysByCard = useMemo(() => {
    const byCard = new Map<string, string[]>();
    for (const reader of openReaders) {
      const owner = owners.get(reader.key);
      if (!owner || reader.key === fullReader || sheetSlots.has(reader.key)) continue;
      const keys = byCard.get(owner.cardId) ?? [];
      keys.push(reader.key);
      byCard.set(owner.cardId, keys);
    }
    return new Map([...byCard].map(([cardId, keys]) => [cardId, keys.join("\n")] as const));
  }, [openReaders, owners, fullReader, sheetSlots]);

  /* A card re-ranked inside its column is moved by React, reader and all; the
     feed positions that move reset come back before paint. */
  useLayoutEffect(() => {
    placement.restoreScrolls();
  });

  /* ── Width → layout mode ─────────────────────────────────────────────── */
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const apply = () => setMode(kanbanLayoutMode(element.getBoundingClientRect().width));
    apply();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ── Flash, flights ──────────────────────────────────────────────────── */
  const flash = useCallback((cardId: string) => {
    const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
    if (!element) return;
    element.classList.remove("flash");
    void element.offsetWidth;
    element.classList.add("flash");
  }, []);
  const previousRects = useRef(new Map<string, { rect: DOMRect; status: string | undefined }>());
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = new Map<string, { rect: DOMRect; status: string | undefined }>();
    const moved: Array<{ element: HTMLElement; from: DOMRect }> = [];
    const reduce = prefersReducedMotion();
    root.querySelectorAll<HTMLElement>(".card[data-id]").forEach((element) => {
      const id = element.dataset.id!;
      const rect = element.getBoundingClientRect();
      const status = element.closest<HTMLElement>(".column")?.dataset.status;
      next.set(id, { rect, status });
      const before = previousRects.current.get(id);
      if (!before || !rect.width) return;
      if (before.status && status && before.status !== status) moved.push({ element, from: before.rect });
    });
    previousRects.current = next;
    if (!moved.length) return;
    if (reduce || moved.length > 6) {
      for (const { element } of moved) {
        element.classList.remove("moved-static");
        void element.offsetWidth;
        element.classList.add("moved-static");
      }
      return;
    }
    for (const { element, from } of moved) fly(element, from, root);
  });

  /* ── Status moves ────────────────────────────────────────────────────── */
  /* Focus follows the card into its new column: the moved card is a new
     element there, so the control the operator used is found again by id. */
  const pendingFocus = useRef<{ cardId: string; status: TaskStatus; target: "card" | "pill" } | null>(null);
  const focusMoved = useCallback((cardId: string, status: TaskStatus, target: "card" | "pill") => {
    pendingFocus.current = { cardId, status, target };
  }, []);
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    const element = rootRef.current?.querySelector<HTMLElement>(`.column[data-status="${wanted.status}"] .card[data-id="${cssEscape(wanted.cardId)}"]`);
    if (!element) return;
    pendingFocus.current = null;
    const focusable = wanted.target === "pill" ? element.querySelector<HTMLElement>(".pill") ?? element : element;
    /* The menu hands focus back to its anchor on close; the anchor was the old
       card, so this runs again on the next frame once that has happened. */
    focusable.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (focusable.isConnected && !focusable.contains(document.activeElement)) focusable.focus({ preventScroll: true });
    });
  });
  const move = useCallback((card: KanbanCardModel, to: TaskStatus, options: { receipt?: boolean; focus?: "card" | "pill" } = {}) => {
    const task = card.task ? tasksById.current.get(card.task.id) ?? card.task : null;
    if (!task) return;
    const from = card.status;
    if (from === to) return;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const short = title.length > 48 ? `${title.slice(0, 46).trimEnd()}…` : title;
    const undo = () => {
      const current = cardsByIdRef.current.get(card.id);
      if (current) move(current, from, { receipt: false });
    };
    const receiptId = options.receipt === false
      ? show(t("kanban.movedBack", { title: short, status: statusLabel(t, to) }))
      : show(t("kanban.moved", { title: short, status: statusLabel(t, to) }), { label: t("kanban.undo"), run: undo });
    if (options.receipt !== false) latestUndo.current = { receiptId, run: undo };
    if (options.focus) focusMoved(card.id, to, options.focus);
    void controller.move(task, to).then((outcome: StatusMoveOutcome) => {
      if (outcome.kind === "failed") {
        dismiss(receiptId);
        if (latestUndo.current?.receiptId === receiptId) latestUndo.current = null;
        flash(card.id);
        show(t("kanban.moveFailed", { title: short, error: outcome.error }), {
          label: t("kanban.retry"),
          run: () => {
            const current = cardsByIdRef.current.get(card.id);
            if (current) move(current, to);
          },
        }, { error: true });
      } else if (outcome.kind === "conflict") {
        dismiss(receiptId);
        if (latestUndo.current?.receiptId === receiptId) latestUndo.current = null;
        flash(card.id);
        show(t("kanban.movedElsewhere", { title: short, status: statusLabel(t, outcome.serverStatus) }), {
          label: t("kanban.moveAnyway"),
          run: () => {
            const current = cardsByIdRef.current.get(card.id);
            if (current) move(current, to);
          },
        }, { error: true });
      }
    });
  }, [controller, dismiss, flash, focusMoved, show, t]);
  const cardsByIdRef = useRef(cardsById);
  cardsByIdRef.current = cardsById;

  const shift = useCallback((card: KanbanCardModel, delta: -1 | 1, focus: "card" | "pill" = "card") => {
    const index = KANBAN_STATUSES.indexOf(card.status) + delta;
    const target = KANBAN_STATUSES[index];
    if (target) move(card, target, { focus });
  }, [move]);

  /* ── Inline title and description (prototype `startEdit`/`commitEdit`) ── */
  /* Drafts belong to the board, keyed by card, so a card that re-ranks, moves
     or re-renders keeps what the operator typed. A refused save keeps the
     draft for Retry; text an agent wrote meanwhile is offered beside it. */
  const [editing, setEditing] = useState<ReadonlyMap<string, { field: EditField; draft: string; base: string }>>(NO_EDITS);
  const [failedEdits, setFailedEdits] = useState<ReadonlyMap<string, { field: EditField; draft: string; base: string; message: string }>>(NO_EDITS);
  const [incomingEdits, setIncomingEdits] = useState<ReadonlyMap<string, { field: EditField; value: string }>>(NO_EDITS);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const failedRef = useRef(failedEdits);
  failedRef.current = failedEdits;
  const incomingRef = useRef(incomingEdits);
  incomingRef.current = incomingEdits;
  /* A card that should hold focus once React has drawn it: the card an edit
     closed on, or the next card after a hide. */
  const pendingCardFocus = useRef<{ cardId: string; fallback: TaskStatus | null; always: boolean } | null>(null);
  const shortTitle = (card: KanbanCardModel) => {
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    return title.length > 48 ? `${title.slice(0, 46).trimEnd()}…` : title;
  };
  const startEdit = useCallback((card: KanbanCardModel, field: EditField) => {
    const task = card.task ? effectiveById.current.get(card.task.id) : undefined;
    if (!task) return;
    const base = textField(task.text, field);
    /* A draft a refused save kept is what the field reopens with. */
    const kept = failedRef.current.get(card.id);
    const retained = kept?.field === field ? kept : null;
    if (retained) setFailedEdits((current) => withEntry(current, card.id, undefined));
    setIncomingEdits((current) => withEntry(current, card.id, undefined));
    setEditing((current) => withEntry(current, card.id, retained
      ? { field, draft: retained.draft, base: retained.base }
      : { field, draft: field === "title" && card.titlePending ? "" : base, base }));
    if (field === "description") {
      setCollapsed((current) => {
        if (!current.has(card.id)) return current;
        const next = new Set(current);
        next.delete(card.id);
        return next;
      });
    }
  }, []);
  /* `base` is the field as the edit found it: a save whose stored field still
     reads `base` goes onto the stored text, whatever else moved there. */
  const saveText = useCallback(async (cardId: string, field: EditField, draft: string, base?: string): Promise<void> => {
    const card = cardsByIdRef.current.get(cardId);
    const raw = card?.task ? tasksById.current.get(card.task.id) : undefined;
    if (!card || !raw) return;
    const value = draft.trim();
    const currentText = effectiveById.current.get(raw.id)?.text ?? raw.text;
    const found = base ?? textField(currentText, field);
    if (field === "title" && !value) {
      setFailedEdits((current) => withEntry(current, cardId, { field, draft, base: found, message: t("kanban.titleRequired") }));
      return;
    }
    if (textField(currentText, field) === value && !(field === "title" && card.titlePending)) {
      setFailedEdits((current) => withEntry(current, cardId, undefined));
      return;
    }
    setFailedEdits((current) => withEntry(current, cardId, undefined));
    const outcome: FieldEditOutcome = await controller.edit(raw, {
      field: "text",
      value: withField(currentText, field, value),
      rebase: (stored) => (textField(stored, field) === found ? withField(stored, field, value) : null),
    });
    if (outcome.kind === "failed") {
      flash(cardId);
      setFailedEdits((current) => withEntry(current, cardId, { field, draft, base: found, message: /[.!?…]$/.test(outcome.error.trim()) ? outcome.error.trim() : `${outcome.error.trim()}.` }));
    } else if (outcome.kind === "conflict") {
      /* An agent wrote this field meanwhile: the editor comes back with the
         operator's draft, and their text beside it. */
      const theirs = textField(typeof outcome.serverValue === "string" ? outcome.serverValue : "", field);
      if (theirs === value) return;
      setEditing((current) => withEntry(current, cardId, { field, draft, base: theirs }));
      setIncomingEdits((current) => withEntry(current, cardId, { field, value: theirs }));
    } else {
      setIncomingEdits((current) => withEntry(current, cardId, undefined));
    }
  }, [controller, flash, t]);
  const commitEdit = useCallback((cardId: string) => {
    const entry = editingRef.current.get(cardId);
    if (!entry) return;
    /* Enter or Save keeps the operator on the card; leaving the field for
       somewhere else leaves focus where they put it. */
    const editor = rootRef.current?.querySelector(`.card[data-id="${cssEscape(cardId)}"] [data-card-editor]`)?.closest(".editor");
    if (editor && editor.contains(document.activeElement)) pendingCardFocus.current = { cardId, fallback: null, always: true };
    setEditing((current) => withEntry(current, cardId, undefined));
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
    void saveText(cardId, entry.field, entry.draft, entry.base);
  }, [saveText]);
  const cancelEdit = useCallback((cardId: string) => {
    pendingCardFocus.current = { cardId, fallback: null, always: true };
    setEditing((current) => withEntry(current, cardId, undefined));
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
  }, []);
  const editDraft = useCallback((cardId: string, draft: string) => {
    setEditing((current) => {
      const entry = current.get(cardId);
      return entry ? withEntry(current, cardId, { ...entry, draft }) : current;
    });
  }, []);
  const focusEditor = (cardId: string) => queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"] [data-card-editor]`)?.focus());
  const retryEdit = useCallback((cardId: string) => {
    const failed = failedRef.current.get(cardId);
    if (!failed) return;
    setFailedEdits((current) => withEntry(current, cardId, undefined));
    void saveText(cardId, failed.field, failed.draft, failed.base);
  }, [saveText]);
  const discardEdit = useCallback((cardId: string) => {
    pendingCardFocus.current = { cardId, fallback: null, always: true };
    setFailedEdits((current) => withEntry(current, cardId, undefined));
  }, []);
  const takeTheirs = useCallback((cardId: string) => {
    const incoming = incomingRef.current.get(cardId);
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
    if (incoming) setEditing((current) => withEntry(current, cardId, { field: incoming.field, draft: incoming.value, base: incoming.value }));
    focusEditor(cardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusEditor reads refs only
  }, []);
  const keepMine = useCallback((cardId: string) => {
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
    focusEditor(cardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusEditor reads refs only
  }, []);
  /* A poll that brings different text into a field being edited never
     overwrites the draft: it is offered beside it, once per change. */
  useEffect(() => {
    if (!editing.size) return;
    let changed = false;
    const nextEditing = new Map(editing);
    let nextIncoming = incomingRef.current;
    for (const [cardId, entry] of editing) {
      const card = cardsByIdRef.current.get(cardId);
      const raw = card?.task ? allTasks.find((task) => task.id === card.task!.id) : undefined;
      /* A write of this device still ahead of the poll is not an agent's text. */
      if (!raw || controller.pending(raw.id) || controller.edits().get(raw.id)?.text !== undefined) continue;
      const theirs = textField(raw.text, entry.field);
      if (theirs === entry.base) continue;
      nextEditing.set(cardId, { ...entry, base: theirs });
      changed = true;
      if (theirs !== entry.draft.trim()) nextIncoming = withEntry(nextIncoming, cardId, { field: entry.field, value: theirs });
    }
    if (!changed) return;
    setEditing(nextEditing);
    setIncomingEdits(nextIncoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the stored rows change
  }, [allTasks]);

  /* ── Colour ─────────────────────────────────────────────────────────────── */
  const setColor = useCallback((card: KanbanCardModel, color: TaskColor | null) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    void controller.edit(raw, { field: "color", value: color }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      flash(card.id);
      show(t("kanban.colorFailed", { title: shortTitle(card), error: outcome.error }), {
        label: t("kanban.retry"),
        run: () => {
          const current = cardsByIdRef.current.get(card.id);
          if (current) setColor(current, color);
        },
      }, { error: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortTitle reads the card it is given
  }, [controller, flash, show, t]);

  /* ── Group hide, one card or a column's worth (prototype `hideTask`/`hideMany`) ── */
  /* Showing a hidden group again: the inverse write, through the same queue. */
  const showGroup = useCallback((taskId: string, title: string, options: { receipt?: boolean; focus?: boolean } = {}) => {
    const raw = tasksById.current.get(taskId);
    if (!raw) return;
    const receiptId = options.receipt !== false ? show(t("kanban.restoredReceipt", { title })) : null;
    if (options.focus) pendingCardFocus.current = { cardId: `task:${taskId}`, fallback: null, always: true };
    void controller.edit(raw, { field: "hide", value: false }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      /* The group is hidden again: the receipt that said otherwise goes. */
      if (receiptId !== null) dismiss(receiptId);
      show(t("kanban.showFailed", { title, error: outcome.error }), { label: t("kanban.retry"), run: () => showGroup(taskId, title, options) }, { error: true });
    });
  }, [controller, dismiss, show, t]);
  /* The card focus moves to when a card leaves its column: the next one, else
     the previous, else the column's menu. */
  const neighbourOf = (cardId: string): { cardId: string; fallback: TaskStatus | null; always: boolean } | null => {
    const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
    if (!element) return null;
    const siblings = [...(element.closest(".col-body")?.querySelectorAll<HTMLElement>(".card[data-id]") ?? [])];
    const index = siblings.indexOf(element);
    const next = siblings[index + 1] ?? siblings[index - 1];
    const status = (element.closest<HTMLElement>(".column")?.dataset.status as TaskStatus | undefined) ?? null;
    return { cardId: next?.dataset.id ?? "", fallback: status, always: element.contains(document.activeElement) };
  };
  const hideFailedReceipt = (card: KanbanCardModel, outcome: Extract<FieldEditOutcome, { kind: "failed" }>, retry: (() => void) | null) => {
    flash(card.id);
    if (outcome.code === "TASK_HIDE_PROTECTED") show(t("kanban.hideProtected", { title: shortTitle(card) }), undefined, { error: true });
    else show(t("kanban.hideFailed", { title: shortTitle(card), error: outcome.error }), retry ? { label: t("kanban.retry"), run: retry } : undefined, { error: true });
  };
  const hideCard = useCallback((card: KanbanCardModel) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    const title = shortTitle(card);
    if (card.holdsSeat) {
      show(t("kanban.hideProtected", { title }), undefined, { error: true });
      return;
    }
    pendingCardFocus.current = neighbourOf(card.id);
    const undo = () => showGroup(raw.id, title, { focus: true });
    const receiptId = show(card.working ? t("kanban.hiddenReceiptWorking", { title, count: card.working }) : t("kanban.hiddenReceipt", { title }), { label: t("kanban.undo"), run: undo });
    latestUndo.current = { receiptId, run: undo };
    void controller.edit(raw, { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      dismiss(receiptId);
      if (latestUndo.current?.receiptId === receiptId) latestUndo.current = null;
      hideFailedReceipt(card, outcome, () => {
        const current = cardsByIdRef.current.get(card.id);
        if (current) hideCard(current);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read refs and the card they are given
  }, [controller, dismiss, show, showGroup, t]);
  /* Many groups at once: every card leaves at once, the writes go one task at
     a time, one Undo brings back every group that was hidden, and each task
     the server refuses comes back with its own receipt. Groups with a working
     agent and the seat's group are never in the list. */
  const hideMany = useCallback((cards: readonly KanbanCardModel[], text: string) => {
    const targets = cards.flatMap((card) => {
      const raw = card.task && !card.holdsSeat ? tasksById.current.get(card.task.id) : undefined;
      return raw ? [{ card, raw }] : [];
    });
    if (!targets.length) return;
    const refused = new Set<string>();
    let previous: Promise<unknown> = Promise.resolve();
    const outcomes = targets.map(({ raw }) => {
      const outcome = controller.edit(raw, { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null }, { after: previous });
      previous = outcome;
      return outcome;
    });
    /* Undo shows every group this hide hid, one write at a time. A group the
       server keeps hidden gets its own receipt with Retry, and the count says
       only how many came back. */
    const undo = () => {
      let chain: Promise<unknown> = Promise.resolve();
      const back = targets.filter(({ raw }) => !refused.has(raw.id)).map(({ card, raw }) => {
        const outcome = controller.edit(tasksById.current.get(raw.id) ?? raw, { field: "hide", value: false }, { after: chain });
        chain = outcome;
        return outcome.then((result) => {
          if (result.kind !== "failed") return true;
          const title = shortTitle(card);
          show(t("kanban.showFailed", { title, error: result.error }), { label: t("kanban.retry"), run: () => showGroup(raw.id, title, { focus: true }) }, { error: true });
          return false;
        });
      });
      void Promise.all(back).then((results) => {
        const count = results.filter(Boolean).length;
        if (count) show(t("kanban.backOnBoardMany", { count }));
      });
    };
    const receiptId = show(text, { label: t("kanban.undo"), run: undo });
    latestUndo.current = { receiptId, run: undo };
    targets.forEach(({ card, raw }, index) => {
      void outcomes[index]!.then((outcome) => {
        if (outcome.kind !== "failed") return;
        refused.add(raw.id);
        hideFailedReceipt(card, outcome, null);
        if (refused.size === targets.length) {
          dismiss(receiptId);
          if (latestUndo.current?.receiptId === receiptId) latestUndo.current = null;
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read refs and the cards they are given
  }, [controller, dismiss, show, showGroup, t]);
  /* The column's own bulk hides, as its menu and the idle divider offer them. */
  const idleToHide = (column: KanbanModel["columns"][TaskStatus]) => column.shown.filter((card) => card.idle && !card.holdsSeat && card.task);
  const hideIdle = (status: TaskStatus) => {
    const idle = idleToHide(modelRef.current.columns[status]);
    hideMany(idle, t("kanban.hiddenIdle", { count: idle.length }));
  };
  useLayoutEffect(() => {
    const wanted = pendingCardFocus.current;
    if (!wanted) return;
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    /* Focus is moved only when the operator's own control went away with the
       change, or the change asked for it. */
    if (!wanted.always && active && active !== document.body && root.contains(active)) {
      pendingCardFocus.current = null;
      return;
    }
    const card = wanted.cardId ? root.querySelector<HTMLElement>(`.card[data-id="${cssEscape(wanted.cardId)}"]`) : null;
    const target = card ?? (wanted.fallback ? root.querySelector<HTMLElement>(`[data-colmenu="${wanted.fallback}"]`) : null);
    if (!target) return;
    pendingCardFocus.current = null;
    target.focus({ preventScroll: !card });
    if (card) card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  /* A hidden group that something newer brought back says so once, as it
     happens; one already back when the board opened says it on its card. */
  const hiddenBefore = useRef<ReadonlySet<string>>(new Set());
  /* The first seat read is the board learning the seat, never a designation. */
  const seatKnownBefore = useRef(false);
  useEffect(() => {
    const now = new Set(model.hiddenGroups.flatMap((card) => (card.task ? [card.task.id] : [])));
    for (const { card, reason } of model.resurfaced) {
      const id = card.task?.id;
      if (!id || !hiddenBefore.current.has(id) || edits.get(id)?.hide !== undefined) continue;
      if (reason.kind === "seat" && !seatKnownBefore.current) continue;
      show(t("kanban.resurfacedReceipt", { title: shortTitle(card), reason: resurfaceText(t, reason) }));
    }
    hiddenBefore.current = now;
    seatKnownBefore.current = seatRefs !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the model only
  }, [model]);

  /* ── Menus ───────────────────────────────────────────────────────────── */
  const statusItems = useCallback((card: KanbanCardModel, hints: boolean): KanbanMenuItem[] => KANBAN_STATUSES.map((status) => ({
    type: "radio" as const,
    status,
    label: statusLabel(t, status),
    why: hints ? t(`kanban.statusHint.${status}`) : null,
    checked: card.status === status,
    onSelect: () => move(card, status, { focus: "pill" }),
  })), [move, t]);
  const menuFor = (): { label: string; items: KanbanMenuItem[] } | null => {
    const open = menu.open;
    if (!open) return null;
    if (open.value.kind === "column") {
      const status = open.value.status;
      const column = model.columns[status];
      const items: KanbanMenuItem[] = [];
      if (status === "assigned") {
        const idle = idleToHide(column);
        items.push({ type: "item", label: t("kanban.hideIdle", { count: idle.length }), why: t("kanban.hideIdleWhy"), disabled: !idle.length, keepFocus: true, onSelect: () => hideMany(idle, t("kanban.hiddenIdle", { count: idle.length })) });
      }
      if (status === "done") {
        const eligible = column.shown.filter((card) => card.task && !card.holdsSeat);
        const finished = eligible.filter((card) => card.activity === 0);
        const kept = eligible.length - finished.length;
        items.push({
          type: "item",
          label: t("kanban.hideFinished", { count: finished.length }),
          why: kept ? t("kanban.hideFinishedKeeps", { count: kept }) : t("kanban.hideFinishedWhy"),
          disabled: !finished.length,
          keepFocus: true,
          onSelect: () => hideMany(finished, kept ? t("kanban.hiddenFinishedKept", { count: finished.length, kept }) : t("kanban.hiddenFinished", { count: finished.length })),
        });
      }
      items.push({
        type: "item",
        label: t("kanban.showHiddenTasks", { count: hiddenCount }),
        disabled: hiddenCount === 0,
        onSelect: () => {
          const pill = rootRef.current?.querySelector<HTMLElement>("[data-hidden-pill]");
          if (pill) queueMicrotask(() => menu.setOpen({ anchor: pill, value: { kind: "tray" } }));
        },
      });
      return { label: t("kanban.columnActions", { column: statusLabel(t, status) }), items };
    }
    if (open.value.kind === "tray" || open.value.kind === "link" || open.value.kind === "stop" || open.value.kind === "account") return null;
    if (open.value.kind === "reader") return readerMenu(open.value.key, open.anchor, open.value.stop);
    if (open.value.kind === "pipeline" || open.value.kind === "stage") return pipelineMenu(open.value);
    const value = open.value;
    const card = cardsById.get(value.cardId);
    if (!card) return null;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const common: KanbanMenuItem[] = [
      { type: "sep" },
      { type: "item", label: t("kanban.prevColumn"), kbd: "[", disabled: card.status === "inbox", onSelect: () => shift(card, -1, "pill") },
      { type: "item", label: t("kanban.nextColumn"), kbd: "]", disabled: card.status === "done", onSelect: () => shift(card, 1, "pill") },
    ];
    if (value.kind === "status") {
      return { label: t("kanban.statusOf", { title }), items: [{ type: "head", label: t("kanban.moveTo") }, ...statusItems(card, true), ...common] };
    }
    const swatches: KanbanMenuItem = {
      type: "swatches",
      label: t("kanban.colour"),
      value: card.color,
      names: (color) => t(`kanban.color.${color ?? "none"}`),
      hex: TASK_COLOR_HEX,
      onPick: (color) => setColor(card, color),
    };
    if (value.kind === "colour") return { label: t("kanban.colour"), items: [{ type: "head", label: t("kanban.colour") }, swatches] };
    return {
      label: t("kanban.cardActions", { title }),
      items: [
        { type: "head", label: t("kanban.moveTo") },
        ...statusItems(card, false),
        { type: "sep" },
        { type: "head", label: t("kanban.colour") },
        swatches,
        { type: "sep" },
        { type: "item", label: collapsed.has(card.id) ? t("kanban.expandCardShort") : t("kanban.collapseCardShort"), onSelect: () => toggleCollapsed(card.id) },
        { type: "item", label: t("kanban.rename"), kbd: "Enter", keepFocus: true, onSelect: () => startEdit(card, "title") },
        { type: "item", label: card.description ? t("kanban.editDescription") : t("kanban.addDescription"), kbd: "E", keepFocus: true, onSelect: () => startEdit(card, "description") },
        { type: "sep" },
        card.holdsSeat
          ? { type: "item", label: t("kanban.hideFromBoard"), why: t("kanban.seatProtected"), disabled: true, onSelect: () => {} }
          : { type: "item", label: t("kanban.hideFromBoard"), kbd: "H", why: card.working ? t("kanban.hideWhyWorking", { count: card.working }) : t("kanban.hideWhy"), keepFocus: true, onSelect: () => hideCard(card) },
      ],
    };
  };
  /* ── A pipeline's actions, and a stage's (prototype `openPipelineMenu`, pane ⋯) ─ */
  const refusalWhy = (option: PipelineActionOption): string | null => (option.refusal ? t(`kanban.pipelineAct.refusal.${option.refusal}`) : null);
  const pipelineMenu = (
    value: { kind: "pipeline"; cardId: string; pipelineId: string } | { kind: "stage"; cardId: string; pipelineId: string; stageId: string; from: "sheet" | "panel" },
  ): { label: string; items: KanbanMenuItem[] } | null => {
    const card = cardsById.get(value.cardId) ?? cards.find((candidate) => candidate.pipelines.some((entry) => entry.pipeline.id === value.pipelineId));
    const summary = card?.pipelines.find((entry) => entry.pipeline.id === value.pipelineId);
    if (!card || !summary) return null;
    const { pipeline } = summary;
    const names = stageNames(t, pipeline);
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const options = new Map(pipelineActionOptions(pipeline).map((option) => [option.action, option] as const));
    const busy = acting.get(pipeline.id);
    const item = (option: PipelineActionOption, label: string, why: string | null): KanbanMenuItem => {
      const stageName = option.stageId ? names.get(option.stageId) ?? option.stageId : null;
      return {
        type: "item",
        label,
        why: busy ? t("kanban.pipelineAct.busy", { action: t(`kanban.pipelineAct.pending.${busy}`) }) : refusalWhy(option) ?? why,
        disabled: Boolean(busy) || option.refusal !== null,
        onSelect: () => startPipelineAction({ pipelineId: pipeline.id, title, action: option.action, stageId: option.stageId, stageName, expectedAttempt: option.attempt }),
      };
    };
    const retry = options.get("retry-stage")!;
    const skip = options.get("skip-stage")!;
    if (value.kind === "stage") {
      const stage = pipeline.stages.find((entry) => entry.id === value.stageId);
      if (!stage) return null;
      const name = names.get(stage.id) ?? stage.id;
      /* Retry and skip act on the stage the pipeline waits on, so a pane offers them only for that stage. */
      const forStage = (option: PipelineActionOption): PipelineActionOption => (option.refusal || option.stageId === stage.id ? option : { ...option, refusal: "other-stage" });
      const items: KanbanMenuItem[] = [{ type: "head", label: t("kanban.stages.stageMenuHead", { stage: name }) }];
      if (stageDraftable(pipeline, stage.id)) {
        const anchor = menu.open?.anchor;
        items.push({
          type: "item",
          label: t("kanban.draft.editMenu"),
          keepFocus: true,
          onSelect: () => {
            /* A folded panel opens, so the field it edits is there to take focus. */
            if (value.from === "panel") foldStagePanel(stagePanelKey(value.cardId, pipeline.id, stage.id), false);
            stageDrafts.begin(pipeline.id, stage.id, stagePromptExtra(stage.prompt));
          },
        });
        /* K6: the first turn's account, chosen in the stage's account picker. */
        if (anchor) {
          items.push({
            type: "item",
            label: t("kanban.account.menuChoose"),
            keepFocus: true,
            onSelect: () => queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "account", target: { kind: "stage", pipelineId: pipeline.id, stageId: stage.id } } })),
          });
        }
      }
      items.push(
        item(forStage(retry), t("kanban.stages.retryThis"), t("kanban.pipelineAct.retryWhy")),
        item(forStage(skip), t("kanban.stages.skipThis"), t("kanban.pipelineAct.skipWhy")),
      );
      if (value.from === "panel") {
        items.push({ type: "sep" }, { type: "item", label: t("kanban.stages.showInStages"), keepFocus: true, onSelect: () => openSheet(card.id, pipeline, stage.id) });
      }
      return { label: t("kanban.stages.stageActions", { stage: name }), items };
    }
    const pauseOrResume = options.get("resume") ?? options.get("pause")!;
    const decision = retry.stageId ? names.get(retry.stageId) ?? retry.stageId : null;
    return {
      label: t("kanban.pipelineAct.menu"),
      items: [
        { type: "head", label: t("kanban.pipelineAct.menu") },
        { type: "item", label: t("kanban.stages.expandTitle"), keepFocus: true, onSelect: () => openSheet(card.id, pipeline) },
        item(pauseOrResume, t(`kanban.pipelineAct.label.${pauseOrResume.action}`, { title, stage: "" }), pauseOrResume.action === "pause" ? t("kanban.pipelineAct.pauseWhy") : null),
        item(retry, decision ? t("kanban.pipelineAct.retryStage", { stage: decision }) : t("kanban.pipelineAct.retryAny"), t("kanban.pipelineAct.retryWhy")),
        item(skip, decision ? t("kanban.pipelineAct.skipStage", { stage: decision }) : t("kanban.pipelineAct.skipAny"), t("kanban.pipelineAct.skipWhy")),
        { type: "sep" },
        item(options.get("close")!, t("kanban.pipelineAct.label.close", { title, stage: "" }), t("kanban.pipelineAct.closeWhy")),
      ],
    };
  };

  /* ── A reader's actions: full pane, link, and Link / Unlink ───────────── */
  const conversationName = (view: ReaderView) => cleanTitle(view.file.title ?? "", 48) || view.owner?.cardTitle || t("kanban.untitledConversation");
  const readerMenu = (key: string, anchor: HTMLElement, stop: ReaderStop): { label: string; items: KanbanMenuItem[] } | null => {
    const view = readerViews.find((candidate) => candidate.readerKey === key);
    if (!view) return null;
    const card = view.owner ? cardsById.get(view.owner.cardId) : undefined;
    const task = card?.task ?? null;
    const ref = task ? assignmentRefFor(task, view.file) : null;
    const name = conversationName(view);
    return {
      label: t("kanban.readerActions"),
      items: [
        { type: "item", label: fullReader === key ? t("kanban.readerLeaveFull") : t("kanban.readerFull"), onSelect: () => toggleFull(key) },
        {
          type: "item",
          label: t("kanban.readerCopyLink"),
          onSelect: () => {
            const link = `${location.origin}${location.pathname}${formatConversationHash({ conversationId: view.file.conversationId ?? undefined, path: view.file.path })}`;
            void navigator.clipboard?.writeText(link).then(() => show(t("kanban.linkCopied", { conversation: name })), () => undefined);
          },
        },
        ...(props.onHandoff && canHandoff(view.file) ? [{
          type: "item" as const,
          label: t("kanban.handoff"),
          why: t("kanban.handoffWhy"),
          onSelect: () => props.onHandoff?.(view.file, view.owner?.cardId ?? null),
        }] : []),
        { type: "sep" },
        {
          type: "item",
          label: t("kanban.linkToTask"),
          why: t("kanban.linkToTaskWhy"),
          onSelect: () => {
            setLinkQuery("");
            queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "link", key } }));
          },
        },
        {
          type: "item",
          label: t("kanban.unlink"),
          why: task && !ref ? t("kanban.unlinkThroughPipeline") : t("kanban.unlinkWhy"),
          disabled: !task || !ref,
          onSelect: () => {
            if (!task || !ref) return;
            const taskTitle = card?.titlePending ? t("kanban.untitled") : card?.title ?? "";
            void assignments.unlink(task.id, ref).then((answer) => {
              if (answer.ok) show(t("kanban.unlinked", { conversation: name, task: taskTitle }));
              else if (answer.status === 409) show(t("kanban.unlinkOwn", { conversation: name, task: taskTitle }), undefined, { error: true });
              else show(t("kanban.unlinkFailed", { conversation: name, error: answer.error }), undefined, { error: true });
            });
          },
        },
        ...(props.onCloseConversation ? [
          { type: "sep" as const },
          {
            type: "item" as const,
            label: t("kanban.closeOnBoard"),
            why: t("kanban.closeOnBoardWhy"),
            onSelect: () => {
              const file = view.file;
              closeReaderFor(key);
              props.onCloseConversation?.(file);
              show(t("kanban.closedReceipt", { conversation: name }), props.onRestoreConversation ? { label: t("kanban.undo"), run: () => props.onRestoreConversation?.(file) } : undefined);
            },
          },
        ] : []),
        ...(stop.state === "hidden" ? [] : [
          { type: "sep" as const },
          {
            type: "item" as const,
            label: view.file.pid === null || view.file.pid === undefined ? t("task.kill") : `${t("task.kill")} · PID ${view.file.pid}`,
            why: stop.state === "disabled" ? stop.reason : t("kanban.stopHostWhy"),
            disabled: stop.state === "disabled",
            onSelect: () => queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "stop", key } })),
          },
        ]),
      ],
    };
  };
  const linkTo = (view: ReaderView, task: BoardTask) => {
    const name = conversationName(view);
    const taskTitle = task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
    void assignments.link(task.id, view.file.path).then((answer) => {
      if (answer.ok) show(t("kanban.linked", { conversation: name, task: taskTitle }));
      else show(t("kanban.linkFailed", { conversation: name, error: answer.error }), undefined, { error: true });
    });
  };

  const openStatusMenu = useCallback((card: KanbanCardModel, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "status", cardId: card.id } }), [menu]);
  const openCardMenu = useCallback((card: KanbanCardModel, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "card", cardId: card.id } }), [menu]);
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ── Keyboard on a card ──────────────────────────────────────────────── */
  const onCardKey = useCallback((card: KanbanCardModel, event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const element = event.currentTarget;
    const key = event.key;
    if (key === "[" && card.task) { event.preventDefault(); shift(card, -1); }
    else if (key === "]" && card.task) { event.preventDefault(); shift(card, 1); }
    else if (key === "Enter" && card.task) { event.preventDefault(); startEdit(card, "title"); }
    else if ((key === "e" || key === "E") && card.task) { event.preventDefault(); startEdit(card, "description"); }
    else if ((key === "h" || key === "H") && card.task) { event.preventDefault(); hideCard(card); }
    else if ((key === "c" || key === "C") && card.task) {
      event.preventDefault();
      const more = element.querySelector<HTMLElement>("[data-menu]");
      if (more) menu.setOpen({ anchor: more, value: { kind: "colour", cardId: card.id } });
    }
    else if ((key === "s" || key === "S") && card.task) {
      event.preventDefault();
      const pill = element.querySelector<HTMLElement>(".pill");
      if (pill) openStatusMenu(card, pill);
    } else if ((key === "m" || key === "M") && card.task) {
      event.preventDefault();
      const more = element.querySelector<HTMLElement>("[data-menu]");
      if (more) openCardMenu(card, more);
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const cards = [...(element.closest(".col-body")?.querySelectorAll<HTMLElement>(".card") ?? [])];
      cards[cards.indexOf(element) + (key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const columns = [...(rootRef.current?.querySelectorAll<HTMLElement>(".column") ?? [])];
      const target = columns[columns.indexOf(element.closest<HTMLElement>(".column")!) + (key === "ArrowRight" ? 1 : -1)];
      if (!target) return;
      const rows = [...(element.closest(".col-body")?.querySelectorAll<HTMLElement>(".card") ?? [])];
      const index = rows.indexOf(element);
      const status = target.dataset.status as TaskStatus;
      if (mode === "tabs") setTab(status);
      queueMicrotask(() => {
        const destination = [...(rootRef.current?.querySelectorAll<HTMLElement>(`.column[data-status="${status}"] .card`) ?? [])];
        (destination[Math.min(index, destination.length - 1)] ?? rootRef.current?.querySelector<HTMLElement>(`[data-colmenu="${status}"]`))?.focus();
      });
    }
  }, [mode, openCardMenu, openStatusMenu, shift, startEdit, hideCard, menu]);

  /* ── Pointer drag to a column ────────────────────────────────────────── */
  const onCardPointerDown = useCallback((card: KanbanCardModel, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || !card.task) return;
    if ((event.target as HTMLElement).closest("button, input, textarea, a, summary, details, .tile, .stage-section, .reader-slot, .stage-detail")) return;
    const element = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let started = false;
    let ghost: HTMLElement | null = null;
    let over: TaskStatus | null = null;
    let overColumn: HTMLElement | null = null;
    const moveHandler = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < 6) return;
        started = true;
        try { element.setPointerCapture(pointerId); } catch { /* capture is best-effort */ }
        element.classList.add("dragging");
        ghost = element.cloneNode(true) as HTMLElement;
        ghost.querySelectorAll(".reader-slot").forEach((slot) => slot.replaceChildren());
        ghost.classList.add("ghost");
        ghost.classList.remove("dragging");
        ghost.style.setProperty("--w", `${element.offsetWidth}px`);
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("data-id");
        rootRef.current?.appendChild(ghost);
        setDragHint(true);
      }
      const rect = element.getBoundingClientRect();
      ghost!.style.left = `${rect.left + dx}px`;
      ghost!.style.top = `${rect.top + dy}px`;
      ghost!.style.display = "none";
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      ghost!.style.display = "";
      /* The drop target is marked on the column element itself: a board
         re-render per pointer move would cost every card a frame. */
      const column = under?.closest<HTMLElement>(".column[data-status]") ?? null;
      if (overColumn && overColumn !== column) overColumn.classList.remove("drop");
      overColumn = column;
      over = column ? column.dataset.status as TaskStatus : null;
      if (column) column.classList.toggle("drop", over !== card.status);
    };
    const finish = (cancel: boolean) => {
      element.removeEventListener("pointermove", moveHandler);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancelled);
      document.removeEventListener("keydown", escape, true);
      if (!started) return;
      element.classList.remove("dragging");
      ghost?.remove();
      overColumn?.classList.remove("drop");
      setDragHint(false);
      if (!cancel && over && over !== card.status) move(card, over);
    };
    const up = () => finish(false);
    const cancelled = () => finish(true);
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && started) {
        keyEvent.stopPropagation();
        finish(true);
      }
    };
    element.addEventListener("pointermove", moveHandler);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancelled);
    document.addEventListener("keydown", escape, true);
  }, [move]);

  /* ── Keys: undo, find ────────────────────────────────────────────────── */
  /* The Stages sheet stands over the board: while it is open, no key the
     board answers reaches behind it. */
  const sheetOpen = useRef(false);
  sheetOpen.current = sheet !== null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const inBoard = Boolean(target && rootRef.current?.contains(target));
      if (event.key === "/") {
        /* Outside the board `/` stays the Viewer's global search. Inside it,
           it finds a task, and the Viewer's window listener must not open
           the search palette over the field it just focused. Under the open
           sheet it does neither. */
        if (!inBoard) return;
        event.preventDefault();
        event.stopPropagation();
        if (!sheetOpen.current) rootRef.current?.querySelector<HTMLInputElement>("[data-kanban-search]")?.focus();
      } else if (event.key === "u" || event.key === "U") {
        if (sheetOpen.current) return;
        if (!inBoard && target !== document.body) return;
        const undo = latestUndo.current;
        if (!undo || !receiptsRef.current.some((receipt) => receipt.id === undo.receiptId)) return;
        event.preventDefault();
        latestUndo.current = null;
        dismiss(undo.receiptId);
        undo.run();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  /* ── Opening what a card holds ───────────────────────────────────────── */
  /* What to bring into view once React has committed: the card, and the
     reader when one was opened. */
  const pendingReveal = useRef<{ cardId: string | null; readerKey: string | null; focusReader: boolean; focusSelector?: string } | null>(null);
  const revealCard = useCallback((cardId: string, readerKey: string | null = null, focusReader = false, focusSelector?: string) => {
    leaveLoose(readerKey);
    const card = cardsByIdRef.current.get(cardId);
    if (card) {
      setCollapsed((current) => {
        if (!current.has(cardId)) return current;
        const next = new Set(current);
        next.delete(cardId);
        return next;
      });
      if (query && !cardMatchesShown(modelRef.current, card)) setQuery("");
      if (modeRef.current === "tabs") setTab(card.status);
    }
    pendingReveal.current = { cardId, readerKey, focusReader, focusSelector };
    setRevealTick((tick) => tick + 1);
  }, [query, leaveLoose]);
  /* What each attention request's handoff changed about a reader, so that
     request's Return undoes exactly that: close a reader it opened, fold again
     one it unfolded. A reader that was already open and expanded is not the
     handoff's to touch. Any gesture of the operator's on that reader makes it
     theirs again. */
  const handoffOwned = useRef(new Map<string, { key: string; restore: "close" | "fold" }>());
  const disown = useCallback((key: string) => {
    for (const [requestId, owned] of handoffOwned.current) if (owned.key === key) handoffOwned.current.delete(requestId);
  }, []);
  const openReaderFor = useCallback((file: FileEntry, options: { focus?: boolean; handoff?: boolean } = {}) => {
    const key = conversationIdentity(file);
    if (!options.handoff) disown(key);
    const owner = ownersRef.current.get(key);
    if (owner) memory.update((readers) => openReader(readers, key, file.path));
    setFocusedReader(key);
    onConversationOpened?.(file.path);
    /* Revealing leaves another loose reader's window, so a new one takes the window after it. */
    revealCard(owner?.cardId ?? "", key, options.focus !== false);
    if (!owner) {
      setLooseReader({ key, path: file.path, project });
      setFullReader(key);
    }
  }, [memory, onConversationOpened, revealCard, disown, project]);
  const [revealTick, setRevealTick] = useState(0);
  useLayoutEffect(() => {
    const wanted = pendingReveal.current;
    if (!wanted) return;
    pendingReveal.current = null;
    const root = rootRef.current;
    if (!root) return;
    const slot = wanted.readerKey ? placement.slotOf(wanted.readerKey) : null;
    const target = slot ?? (wanted.cardId ? root.querySelector<HTMLElement>(`.card[data-id="${cssEscape(wanted.cardId)}"]`) : null);
    if (!target) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (slot && wanted.focusReader) slot.querySelector<HTMLElement>("[data-kanban-reader]")?.focus({ preventScroll: true });
    if (wanted.focusSelector) target.querySelector<HTMLElement>(wanted.focusSelector)?.focus({ preventScroll: true });
  }, [revealTick, placement]);
  const ownersRef = useRef(owners);
  ownersRef.current = owners;
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const modelRef = useRef(model);
  modelRef.current = model;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /* A conversation an attempt or a review round recorded: its reader when the
     board carries its transcript. One this board does not carry (an older
     attempt the scheme window left out) opens through the Viewer's own
     conversation link, whose resolver pins the transcript for the next poll.
     No view preference is written. */
  const openRecorded = useCallback((conversation: { path: string | null; conversationId: string | null }) => {
    const file = (conversation.path ? filesByPath.get(conversation.path) : undefined)
      ?? (conversation.conversationId ? files.find((entry) => entry.conversationId === conversation.conversationId) : undefined);
    if (file) {
      openReaderFor(file);
      return;
    }
    if (conversation.conversationId || conversation.path) {
      location.hash = formatConversationHash({ conversationId: conversation.conversationId ?? undefined, path: conversation.path ?? "" });
    }
  }, [files, filesByPath, openReaderFor]);
  /* A node or chip opens what its stage has: the latest own attempt's
     conversation, or, for a stage that has not started, its first message in
     a panel on the card (prototype `openStage`). */
  const pendingPanelFocus = useRef<string | null>(null);
  const openStage = useCallback((pipeline: Pipeline, stage: PipelineStage, cardId?: string) => {
    const attempt = latestAttempt(pipeline, stage.id);
    if (attempt) {
      openRecorded({ path: attempt.agentPath, conversationId: attempt.conversationId });
      return;
    }
    if (!cardId || !stageDraftable(pipeline, stage.id)) return;
    const key = stagePanelKey(cardId, pipeline.id, stage.id);
    setStagePanels((current) => withEntry(current, key, { cardId, pipelineId: pipeline.id, stageId: stage.id, folded: false }));
    pendingPanelFocus.current = key;
    revealCard(cardId);
  }, [openRecorded, revealCard]);
  useLayoutEffect(() => {
    const key = pendingPanelFocus.current;
    if (!key) return;
    const panel = rootRef.current?.querySelector<HTMLElement>(`[data-stage-detail="${cssEscape(key)}"]`);
    if (!panel) return;
    pendingPanelFocus.current = null;
    panel.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    panel.focus({ preventScroll: true });
  });
  const foldStagePanel = useCallback((key: string, folded: boolean) => {
    setStagePanels((current) => {
      const panel = current.get(key);
      return panel && panel.folded !== folded ? withEntry(current, key, { ...panel, folded }) : current;
    });
  }, []);
  const closeStagePanel = useCallback((key: string) => {
    const cardId = stagePanels.get(key)?.cardId;
    setStagePanels((current) => withEntry(current, key, undefined));
    if (cardId) queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`)?.focus({ preventScroll: true }));
  }, [stagePanels]);
  const openStagePanelMenu = useCallback((key: string, anchor: HTMLElement) => {
    const panel = stagePanels.get(key);
    if (panel) menu.setOpen({ anchor, value: { kind: "stage", cardId: panel.cardId, pipelineId: panel.pipelineId, stageId: panel.stageId, from: "panel" } });
  }, [stagePanels, menu]);
  /* A draft the stage's record makes moot goes, wherever it was open: the
     stage started with its words, or its words were never changed. */
  useEffect(() => {
    const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
    for (const [key, draft] of stageDrafts.entries()) {
      const pipeline = byId.get(draft.pipelineId);
      if (pipeline) stageDrafts.settleFromStage(key, pipeline);
    }
  }, [pipelines, draftsVersion, stageDrafts]);
  /* When a waiting stage starts, its panel becomes that conversation's reader,
     folded as the panel was. A draft the start overtook keeps the panel, which
     says the draft was not delivered, until the operator lets it go. A panel
     whose pipeline left the board goes with it. */
  useEffect(() => {
    if (!stagePanels.size) return;
    let next = stagePanels;
    const promoted: Array<{ file: FileEntry; folded: boolean }> = [];
    for (const [key, panel] of stagePanels) {
      const summary = cards.flatMap((card) => card.pipelines).find((entry) => entry.pipeline.id === panel.pipelineId);
      const stage = summary?.pipeline.stages.find((entry) => entry.id === panel.stageId);
      if (!summary || !stage) {
        next = withEntry(next, key, undefined);
        continue;
      }
      const draft = stageDrafts.get(stageDraftKey(panel.pipelineId, panel.stageId));
      if (stageNotStarted(summary.pipeline, stage.id) || (draft && draftOutcome(summary.pipeline, stage.id, draft) !== "included")) continue;
      const attempt = latestAttempt(summary.pipeline, stage.id);
      const file = attempt ? (attempt.agentPath ? filesByPath.get(attempt.agentPath) : undefined) ?? (attempt.conversationId ? filesByConversation.get(attempt.conversationId) : undefined) : undefined;
      /* The attempt's conversation is not on the board yet: the panel waits for it. */
      if (!file) continue;
      next = withEntry(next, key, undefined);
      promoted.push({ file, folded: panel.folded });
    }
    if (next !== stagePanels) setStagePanels(next);
    if (promoted.length) {
      memory.update((readers) => promoted.reduce<OpenReader[]>((current, { file, folded }) => {
        const key = conversationIdentity(file);
        const opened = openReader(current, key, file.path);
        return folded ? foldReader(opened, key, true) : opened;
      }, [...readers]));
    }
  }, [stagePanels, cards, draftsVersion, stageDrafts, filesByPath, filesByConversation, memory]);
  const panelsByCard = useMemo(() => {
    const byCard = new Map<string, string[]>();
    for (const panel of stagePanels.values()) {
      const lines = byCard.get(panel.cardId) ?? [];
      lines.push(`${panel.pipelineId}\t${panel.stageId}\t${panel.folded ? "1" : "0"}`);
      byCard.set(panel.cardId, lines);
    }
    return new Map([...byCard].map(([cardId, lines]) => [cardId, lines.join("\n")] as const));
  }, [stagePanels]);

  /* ── The Stages sheet ─────────────────────────────────────────────────── */
  const openSheet = useCallback((cardId: string, pipeline: Pipeline, stageId?: string) => {
    const summary = cardsByIdRef.current.get(cardId)?.pipelines.find((entry) => entry.pipeline.id === pipeline.id);
    const focus = stageId ?? (summary ? currentStageId(summary.pipeline, summary.views) : null);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSheet({ cardId, pipelineId: pipeline.id, focus, opener });
  }, []);
  const closeSheet = useCallback(() => {
    setSheet((current) => {
      if (current) {
        const { opener, cardId, pipelineId } = current;
        /* Back to what opened the sheet, else the card's own Stages button. */
        queueMicrotask(() => {
          const root = rootRef.current;
          const card = root?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
          const button = card?.querySelector<HTMLElement>(`[data-open-stages="${cssEscape(pipelineId)}"]`);
          const back = opener?.isConnected && opener !== document.body && root?.contains(opener)
            ? opener
            : button ?? card ?? root?.querySelector<HTMLElement>(".board-frame");
          back?.focus({ preventScroll: true });
        });
      }
      return null;
    });
  }, []);
  /* A pipeline no card holds any more takes its sheet with it. */
  useEffect(() => {
    if (sheet && !sheetSummary) closeSheet();
  }, [sheet, sheetSummary, closeSheet]);
  const foldPanes = useCallback((pipelineId: string, stageIds: readonly string[], folded: boolean) => {
    setPaneFolds((current) => {
      const next = new Set(current);
      for (const stageId of stageIds) {
        if (folded) next.add(stageDraftKey(pipelineId, stageId));
        else next.delete(stageDraftKey(pipelineId, stageId));
      }
      return next;
    });
  }, []);

  /* ── Pipeline actions over the pipeline route (`usePipelineActions`) ──── */
  const { acting, start: startPipelineAction } = usePipelineActions(pipelinePorts, show, t);
  /* K6: the account of a waiting stage's first turn, and of a conversation. */
  const accountChoice = useAccountChoices(pipelinePorts, show, t, useCallback((target: AccountTarget, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "account", target } }), [menu]));
  const actingByCard = useMemo(() => {
    const byCard = new Map<string, string>();
    if (!acting.size) return byCard;
    for (const card of cards) {
      const lines = card.pipelines.flatMap((entry) => (acting.has(entry.pipeline.id) ? [`${entry.pipeline.id}\t${acting.get(entry.pipeline.id)}`] : []));
      if (lines.length) byCard.set(card.id, lines.join("\n"));
    }
    return byCard;
  }, [acting, cards]);
  const flowsById = useMemo(() => new Map(props.flows.map((flow) => [flow.id, flow] as const)), [props.flows]);
  const openPipelineMenu = useCallback((cardId: string, pipeline: Pipeline, anchor: HTMLElement) => {
    menu.setOpen({ anchor, value: { kind: "pipeline", cardId, pipelineId: pipeline.id } });
  }, [menu]);
  const foldReaderFor = useCallback((key: string, folded: boolean) => {
    disown(key);
    memory.update((readers) => foldReader(readers, key, folded));
  }, [memory, disown]);
  const closeReaderFor = useCallback((key: string) => {
    disown(key);
    const cardId = ownersRef.current.get(key)?.cardId;
    setFullReader((current) => (current === key ? null : current));
    setLooseReader((current) => (current?.key === key ? null : current));
    memory.update((readers) => closeReader(readers, key));
    if (cardId) queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`)?.focus({ preventScroll: true }));
  }, [memory, disown]);
  const openReaderMenu = useCallback((key: string, anchor: HTMLElement, stop: ReaderStop) => menu.setOpen({ anchor, value: { kind: "reader", key, stop } }), [menu]);

  /* A conversation the Viewer was asked to open lands in its reader. */
  const focusTarget = props.focus ?? null;
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.startsWith("task::")) {
      const cardId = `task:${focusTarget.slice("task::".length)}`;
      if (cardsByIdRef.current.has(cardId)) revealCard(cardId);
      return;
    }
    /* A pipeline link: the card that holds the pipeline, revealed and focused. */
    if (focusTarget.startsWith("group::pipeline::")) {
      const cardId = anchorsRef.current.get(focusTarget);
      if (cardId) {
        revealCard(cardId);
        focusCard(cardId);
      }
      return;
    }
    if (focusTarget.startsWith("draft::")) {
      const id = focusTarget.slice("draft::".length);
      const holder = [...cardsByIdRef.current.values()].find((card) => card.drafts.includes(id));
      if (holder) revealCard(holder.id, null, false, `[data-kanban-draft="${cssEscape(id)}"] textarea`);
      return;
    }
    const file = filesByPath.get(focusTarget);
    if (!file) return;
    /* On its card, or, for a conversation no card holds, as a reader of its own in the window. */
    openReaderFor(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one open per request
  }, [focusTarget]);

  const focusCard = useCallback((cardId: string) => {
    const card = cardsById.get(cardId);
    if (card && mode === "tabs") setTab(card.status);
    queueMicrotask(() => {
      const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
      element?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      element?.focus({ preventScroll: true });
      if (element) flash(cardId);
    });
  }, [cardsById, flash, mode]);

  /* ── Presence: what the operator can actually see ────────────────────── */
  /* A card counts as seen when it intersects its column's scroll box, the
     board and the window, in a column that is displayed (one tab at a time on
     a tabbed board). Measured after each render, on a resize, and around a
     scroll — throttled while it runs and settled once it stops. */
  /* Kept out of React state (#1546): the measurement feeds the presence report
     and nothing the board draws, so writing it into state re-rendered the board
     and every column on each scroll frame for a value no card reads. The ref
     holds it and the report runs straight from the measurement. */
  const visibleCardsRef = useRef("");
  const reportPresenceRef = useRef<() => void>(() => {});
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let timer = 0;
    let measuredAt = 0;
    const measure = () => {
      frame = 0;
      measuredAt = performance.now();
      const rootRect = root.getBoundingClientRect();
      const ids: string[] = [];
      root.querySelectorAll<HTMLElement>(".column[data-status]").forEach((column) => {
        if (window.getComputedStyle(column).display === "none") return;
        const body = column.querySelector<HTMLElement>(".col-body");
        if (!body) return;
        const box = body.getBoundingClientRect();
        const top = Math.max(box.top, rootRect.top, 0);
        const bottom = Math.min(box.bottom, rootRect.bottom, window.innerHeight);
        const left = Math.max(box.left, rootRect.left, 0);
        const right = Math.min(box.right, rootRect.right, window.innerWidth);
        if (bottom <= top || right <= left) return;
        body.querySelectorAll<HTMLElement>(".card[data-id]").forEach((card) => {
          const rect = card.getBoundingClientRect();
          if (rect.width > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right) ids.push(card.dataset.id!);
        });
      });
      const next = ids.join("\n");
      if (next === visibleCardsRef.current) return;
      visibleCardsRef.current = next;
      reportPresenceRef.current();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    /* Every card's rect is read here, so measuring once per scroll frame was
       the forced layout #1546 measured. A gesture is throttled to
       SCROLL_MEASURE_MS and always settles with a final measurement
       SCROLL_SETTLE_MS after the last scroll event, so what presence reports
       once the operator stops is the same set the per-frame scan reported —
       and never more than one throttle window stale while they are moving.
       An IntersectionObserver cannot express this predicate: visibility here is
       the intersection of the card with its column body, the board and the
       viewport, and an observer carries one root. */
    const settle = () => {
      timer = 0;
      schedule();
    };
    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(settle, SCROLL_SETTLE_MS);
      if (performance.now() - measuredAt >= SCROLL_MEASURE_MS) schedule();
    };
    schedule();
    root.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(root);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [model, mode, tab, collapsed, openReaders]);
  /* The conversation the operator is in: the reader holding keyboard focus,
     else the one opened last, while it stays open and expanded. */
  const [focusedReader, setFocusedReader] = useState<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sync = () => {
      const active = document.activeElement as HTMLElement | null;
      const reader = typeof active?.closest === "function" ? active.closest<HTMLElement>("[data-kanban-reader]") : null;
      if (reader && root.contains(reader)) setFocusedReader(reader.dataset.kanbanReader ?? null);
    };
    const later = () => queueMicrotask(sync);
    root.addEventListener("focusin", sync);
    root.addEventListener("focusout", later);
    return () => {
      root.removeEventListener("focusin", sync);
      root.removeEventListener("focusout", later);
    };
  }, []);
  const focusedView = focusedReader ? readerViews.find((view) => view.readerKey === focusedReader && !view.folded) : undefined;
  const focusedPath = focusedView?.file.path ?? null;
  /* The bus drops a report that reproduces the current slice, which is what the
     `presenceSignature` memo used to spare this effect; the measurement calls
     straight into it now, so the dedupe stays where it always was. */
  const reportPresence = useCallback(() => {
    const paths: string[] = [];
    for (const id of visibleCardsRef.current ? visibleCardsRef.current.split("\n") : []) {
      for (const member of cardsById.get(id)?.members ?? []) paths.push(member.file.path);
    }
    viewBus.reportSlice({
      mode: "scheme",
      focusedPath,
      selectedPaths: selectionInOrder(paths, selection, { includeUnordered: true }),
      visiblePaths: paths.slice(0, MAX_VISIBLE_PATHS),
      camera: null,
    });
  }, [cardsById, selection, focusedPath]);
  reportPresenceRef.current = reportPresence;
  useEffect(() => { reportPresence(); }, [reportPresence]);

  /* ── Focus handoff: the board half, without a camera (#688, C6) ──────── */
  /* Conversations no card holds resolve too: a handoff opens them as a reader of their own. */
  const looseAnchors = useMemo(() => new Set(files.filter((file) => !owners.has(conversationIdentity(file))).map((file) => file.path)), [files, owners]);
  const focusIndex = useMemo(() => kanbanFocusIndex(model, anchors, project, looseAnchors), [model, anchors, project, looseAnchors]);
  useEffect(() => focusHandoffBus.setBoard({
    project,
    index: focusIndex,
    moveTo: (destination) => {
      const anchor = destination.anchorKeys.find((key) => anchors.has(key));
      const cardId = anchor ? anchors.get(anchor) : undefined;
      const loosePath = !cardId ? destination.anchorKeys.find((key) => looseAnchors.has(key)) ?? (destination.path && looseAnchors.has(destination.path) ? destination.path : undefined) : undefined;
      if (!cardId && !loosePath) return false;
      /* A conversation no card holds has one surface, its reader, for `show` as for `open`. */
      const file = loosePath ? filesByPath.get(loosePath) : destination.intent === "open" && destination.path ? filesByPath.get(destination.path) : undefined;
      if (file) {
        const key = conversationIdentity(file);
        const requestId = destination.requestId ?? "";
        const before = openReadersRef.current.find((reader) => reader.key === key);
        /* A resumed move finds the reader it already opened: ownership stays as
           the first move recorded it. */
        if (!handoffOwned.current.has(requestId) && (!before || before.folded)) {
          handoffOwned.current.set(requestId, { key, restore: before ? "fold" : "close" });
        }
        openReaderFor(file, { focus: false, handoff: true });
      } else if (cardId) {
        revealCard(cardId);
      }
      return true;
    },
    restoreCamera: () => false,
    arrival: (destination) => {
      const root = rootRef.current;
      if (!root) return null;
      const loosePath = destination.anchorKeys.find((key) => looseAnchors.has(key) && !anchors.has(key)) ?? (destination.path && looseAnchors.has(destination.path) ? destination.path : undefined);
      if (loosePath) {
        const looseFile = filesByPath.get(loosePath);
        return looseFile && readerArrived(root, placement.slotOf(conversationIdentity(looseFile))) ? (destination.intent === "open" ? "reader" : "visible") : null;
      }
      /* A loose reader's window covers the board: nothing under it has arrived, and a resumed handoff moves again. */
      if (looseRef.current) return null;
      const file = destination.intent === "open" && destination.path ? filesByPath.get(destination.path) : undefined;
      if (file && readerArrived(root, placement.slotOf(conversationIdentity(file)))) return "reader";
      const anchor = destination.anchorKeys.find((key) => anchors.has(key));
      const cardId = anchor ? anchors.get(anchor) : undefined;
      return cardId && cardOnScreen(root, cardId, cssEscape) ? "visible" : null;
    },
    returnFromHandoff: (requestId) => {
      const owned = handoffOwned.current.get(requestId ?? "");
      if (!owned) return;
      handoffOwned.current.delete(requestId ?? "");
      if (owned.restore === "fold") memory.update((readers) => foldReader(readers, owned.key, true));
      else {
        setFullReader((current) => (current === owned.key ? null : current));
        memory.update((readers) => closeReader(readers, owned.key));
      }
    },
  }), [project, focusIndex, anchors, looseAnchors, filesByPath, openReaderFor, revealCard, memory, placement]);

  /* ── What the board is not drawing: hidden groups, empty tasks off the
     board, and conversations closed on it ─────────────────────────────── */
  const closedFiles = useMemo(
    () => (props.onRestoreConversation ? (props.closedPaths ?? []).flatMap((path) => filesByPath.get(path) ?? []) : []),
    [props.onRestoreConversation, props.closedPaths, filesByPath],
  );
  const hiddenCount = model.hiddenGroups.length + model.offBoard.length + closedFiles.length;
  const restoreConversation = useCallback((file: FileEntry) => {
    props.onRestoreConversation?.(file);
    show(t("kanban.restoredReceipt", { title: cleanTitle(file.title ?? "", 48) || t("kanban.untitledConversation") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handler prop is read when called
  }, [props.onRestoreConversation, show, t]);

  /* ── Show an off-board task again (existing `board` preference) ───────── */
  const showOnBoard = useCallback((task: BoardTask) => {
    const title = task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
    void updateTask(task.id, { board: "shown" }).then((error) => {
      if (error) show(t("kanban.showFailed", { title, error }), undefined, { error: true });
      else show(t("kanban.shownReceipt", { title }));
    });
  }, [show, t]);

  const onboardCount = model.totals.onBoard;
  const filtering = query.trim().length > 0;
  const openMenu = menuFor();
  const trayOpen = menu.open?.value.kind === "tray" ? menu.open : null;
  const linkOpen = menu.open?.value.kind === "link" ? menu.open : null;
  const stopOpen = menu.open?.value.kind === "stop" ? menu.open : null;
  const accountOpen = menu.open?.value.kind === "account" ? menu.open : null;
  /* The picker reads the pipeline and the conversation as the board holds them now. */
  const accountOverlay = (target: AccountTarget, anchor: HTMLElement) => {
    if (target.kind === "stage") {
      const pipeline = cards.flatMap((card) => card.pipelines).find((entry) => entry.pipeline.id === target.pipelineId)?.pipeline;
      const stage = pipeline?.stages.find((entry) => entry.id === target.stageId);
      if (!pipeline || !stage) return null;
      return <StageAccountPopover anchor={anchor} onClose={menu.close} pipeline={pipeline} stage={stage} name={stageNames(t, pipeline).get(stage.id) ?? stage.id} />;
    }
    const view = readerViews.find((candidate) => candidate.readerKey === target.readerKey);
    if (!view) return null;
    const role = view.owner?.stage ? stageNames(t, view.owner.stage.pipeline).get(view.owner.stage.stage.id) ?? null : null;
    return <ConversationAccountPopover anchor={anchor} onClose={menu.close} file={view.file} name={role ?? conversationName(view)} stageContext={view.owner?.stage ?? null} />;
  };
  const stopKey = stopOpen && stopOpen.value.kind === "stop" ? stopOpen.value.key : null;
  const stopView = stopKey ? readerViews.find((view) => view.readerKey === stopKey) ?? null : null;
  const linkKey = linkOpen && linkOpen.value.kind === "link" ? linkOpen.value.key : null;
  const linkView = linkKey ? readerViews.find((view) => view.readerKey === linkKey) ?? null : null;
  const linkOwnerTask = linkView?.owner ? cardsById.get(linkView.owner.cardId)?.task ?? null : null;
  const linkCandidates = linkView ? allTasks
    .filter((task) => task.id !== linkOwnerTask?.id && task.board !== "hidden")
    .filter((task) => !linkQuery.trim() || task.text.toLowerCase().includes(linkQuery.trim().toLowerCase()))
    .slice(0, 50) : [];
  /* A shelf column holding an open conversation widens to reading width. */
  const readingStatuses = new Set<TaskStatus>();
  for (const view of readerViews) {
    /* A conversation standing in the Stages sheet is not in its column. */
    if (view.folded || !view.owner || view.inSheet) continue;
    const card = cardsById.get(view.owner.cardId);
    if (card && card.status !== "assigned" && !collapsed.has(card.id)) readingStatuses.add(card.status);
  }
  /* So does one holding an agent draft, and Inbox while `+ Task` composes in it. */
  for (const card of cardsById.values()) {
    if (card.drafts.length && card.status !== "assigned" && !collapsed.has(card.id)) readingStatuses.add(card.status);
  }
  if (composingTask) readingStatuses.add("inbox");
  const readingStyle = (mode === "wide" || mode === "narrow") && readingStatuses.size
    ? ({ "--c-assigned": "minmax(440px, 1fr)", ...Object.fromEntries([...readingStatuses].map((status) => [`--c-${status}`, "minmax(420px, 460px)"])) } as CSSProperties)
    : undefined;

  /* ── K9a: + Task, + Agent and the drafts cards hold ─────────────────── */
  const openNewTask = () => {
    setComposingTask(true);
    if (mode === "tabs") setTab("inbox");
    queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>("[data-kanban-new-task]")?.scrollIntoView({ block: "nearest", behavior: "auto" }));
  };
  const closeNewTask = useCallback(() => {
    setComposingTask(false);
    queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>("[data-new-task]")?.focus({ preventScroll: true }));
  }, []);
  const taskCreated = useCallback((task: BoardTask) => {
    setComposingTask(false);
    setCreatedTasks((current) => [...current.filter((entry) => entry.task.id !== task.id), { task, basis: storedTasksRef.current }]);
    show(t("kanban.taskCreated", { title: task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled") }));
    revealCard(`task:${task.id}`, null, false, ".title-trigger");
  }, [show, t, revealCard]);
  const addAgentRef = useRef(props.onAddAgent);
  addAgentRef.current = props.onAddAgent;
  const addAgentToCard = useCallback((card: KanbanCardModel) => addAgentRef.current?.({ id: card.id, task: card.task, title: card.title }), []);
  /* The dashboard hands a fresh callback on each of its renders; readers get one that stays the same. */
  const spawnRetryRef = useRef(props.onSpawnRetry);
  spawnRetryRef.current = props.onSpawnRetry;
  const spawnRetry = useCallback((file: FileEntry) => spawnRetryRef.current?.(file), []);
  const draftCloseRef = useRef(props.onDraftClose);
  draftCloseRef.current = props.onDraftClose;
  const draftSpawnedRef = useRef(props.onDraftSpawned);
  draftSpawnedRef.current = props.onDraftSpawned;
  const draftActions = useMemo<KanbanDraftActions>(() => ({
    project,
    files,
    onClose: (id) => draftCloseRef.current?.(id),
    onSpawned: (id, file) => draftSpawnedRef.current?.(id, file),
  }), [project, files]);

  const columnsView = KANBAN_STATUSES.map((status) => (
    <KanbanColumnView
      key={status}
      status={status}
      model={model}
      mode={mode}
      activeTab={tab}
      filtering={filtering}
      collapsed={collapsed}
      nowMs={modelNow * 1000}
      pendingIds={controller}
      editing={editing}
      failedEdits={failedEdits}
      incomingEdits={incomingEdits}
      onHideIdle={() => hideIdle(status)}
      reading={readingStatuses.has(status)}
      readerKeysByCard={readerKeysByCard}
      panelsByCard={panelsByCard}
      actingByCard={actingByCard}
      placement={placement}
      newTask={status === "inbox" && composingTask ? <KanbanTaskComposer project={project} onCreated={taskCreated} onCancel={closeNewTask} /> : null}
      onColumnMenu={(anchor) => menu.setOpen({ anchor, value: { kind: "column", status } })}
      cardProps={{
        onToggleCollapsed: toggleCollapsed,
        onStatusMenu: openStatusMenu,
        onCardMenu: openCardMenu,
        onKey: onCardKey,
        onPointerDown: onCardPointerDown,
        onOpenMember: openReaderFor,
        onOpenStage: openStage,
        onFocusCard: focusCard,
        onOpenConversations,
        onStartEdit: startEdit,
        onEditDraft: editDraft,
        onCommitEdit: commitEdit,
        onCancelEdit: cancelEdit,
        onRetryEdit: retryEdit,
        onDiscardEdit: discardEdit,
        onUseTheirs: takeTheirs,
        onKeepMine: keepMine,
        onHide: hideCard,
        graphChoices,
        onToggleGraph: toggleGraph,
        onOpenAttempt: openRecorded,
        drafts: stageDrafts,
        pipelinePorts,
        onOpenSheet: openSheet,
        onPipelineMenu: openPipelineMenu,
        onStagePanelFold: foldStagePanel,
        onStagePanelClose: closeStagePanel,
        onStagePanelMenu: openStagePanelMenu,
        onAddAgent: props.onAddAgent ? addAgentToCard : undefined,
      }}
    />
  ));
  const sheetView = sheet && sheetSummary ? (
    <StagesSheet
      key={`${sheet.cardId}|${sheet.pipelineId}`}
      title={sheetSummary.card.titlePending ? t("kanban.untitled") : sheetSummary.card.title}
      summary={sheetSummary.summary}
      panes={sheetPanes}
      flowsById={flowsById}
      initialFocus={sheet.focus}
      fullReader={fullReader}
      placement={placement}
      drafts={stageDrafts}
      ports={pipelinePorts}
      onFold={(stageId, folded) => foldPanes(sheet.pipelineId, [stageId], folded)}
      onFoldMany={(stageIds, folded) => foldPanes(sheet.pipelineId, stageIds, folded)}
      onChooseAttempt={(stageId, n) => setPaneAttempts((current) => withEntry(current, stageDraftKey(sheet.pipelineId, stageId), n))}
      onStageMenu={(stage, anchor) => menu.setOpen({ anchor, value: { kind: "stage", cardId: sheetSummary.card.id, pipelineId: sheet.pipelineId, stageId: stage.id, from: "sheet" } })}
      onOpenRecorded={openRecorded}
      onLeaveFull={(key) => setFullReader((current) => (current === key ? null : current))}
      onClose={closeSheet}
    />
  ) : null;

  return (
    <AccountChoiceContext.Provider value={accountChoice}>
    <KanbanDraftContext.Provider value={draftActions}>
    <div ref={rootRef} className="kb" data-kanban-board="" data-mode={mode}>
      <header className="bar">
        <span className="summary">
          <span className="dot" aria-hidden="true" />
          <span className="num">{t("kanban.summaryWorking", { count: model.totals.working })}</span>
          {model.totals.needsYou ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="dot warn" aria-hidden="true" />
              <span className="num">{t("kanban.summaryNeeds", { count: model.totals.needsYou })}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className="num">{t("kanban.summaryTasks", { count: onboardCount })}</span>
        </span>
        {catalogFailures > 0 ? <span className="bar-alert" role="alert">{t("kanban.filesFailed")}</span> : null}
        <span className="grow" />
        <div className="bar-tools">
          <label className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              type="search"
              placeholder={t("kanban.find")}
              aria-label={t("kanban.find")}
              data-kanban-search=""
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn hidden-pill"
            data-count={hiddenCount}
            data-hidden-pill=""
            aria-label={t("kanban.hiddenAria", { count: hiddenCount })}
            onClick={(event) => menu.setOpen({ anchor: event.currentTarget, value: { kind: "tray" } })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6 0 10 8 10 8a17.7 17.7 0 0 1-3.2 4.1" /><path d="M6.6 6.6C3.9 8.5 2 12 2 12s4 8 10 8a10.9 10.9 0 0 0 4.4-.9" /></svg>
            {t("kanban.hidden")} <span className="count num">{hiddenCount}</span>
          </button>
          {props.viewSwitch ? <span className="view-switch">{props.viewSwitch}</span> : null}
        </div>
        <div className="bar-create">
          <button type="button" className="btn" data-new-task="" aria-label={t("dash.newTask")} aria-expanded={composingTask} onClick={openNewTask}>
            <span className="plus" aria-hidden="true">+</span> {t("dash.task")}
          </button>
          {props.onNewAgent ? (
            <button type="button" className="btn" data-new-agent="" aria-label={t("dash.newConvo")} disabled={!loaded} onClick={props.onNewAgent}>
              <span className="plus" aria-hidden="true">+</span> {t("dash.agent")}
            </button>
          ) : null}
        </div>
      </header>

      <div className="kb-page">
      {props.seat ? props.seat(boardId, props.seatRefs === undefined ? seatRead : null) : null}
      <div className="board-frame" id={boardId} tabIndex={-1} aria-label={t("kanban.columns")}>
      {!loaded ? (
        <div className="board-loading" role="status">{t("kanban.loading")}</div>
      ) : (
        /* One tree for every width: the navigation above the columns changes with the mode and the columns
           stay mounted, so crossing a breakpoint keeps every card, its draft panes and their launches. */
        <div className="scroll-wrap" data-board-wrap={mode}>
          {mode === "tabs" ? (
            <div className="tabs-nav" role="tablist" aria-label={t("kanban.columns")}>
              {KANBAN_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="tab"
                  aria-selected={tab === status}
                  aria-controls={`kb-col-${status}`}
                  data-tab={status}
                  onClick={() => setTab(status)}
                >
                  {statusLabel(t, status)}
                  <span className="n num">{model.columns[status].cards.length}</span>
                </button>
              ))}
            </div>
          ) : mode === "scroll" ? (
            <div className="tabs-nav jump" aria-label={t("kanban.columns")}>
              {KANBAN_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-label={t("kanban.scrollTo", { column: statusLabel(t, status) })}
                  onClick={() => rootRef.current?.querySelector(`.column[data-status="${status}"]`)?.scrollIntoView({ inline: "start", block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" })}
                >
                  {statusLabel(t, status)}
                  <span className="n num">{model.columns[status].cards.length}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div
            className={`board${mode === "tabs" ? " tabs" : mode === "scroll" ? " scroll" : mode === "narrow" ? " narrow" : ""}${(mode === "wide" || mode === "narrow") && readingStatuses.size ? " reading" : ""}`}
            data-board=""
            data-mode={mode}
            style={readingStyle}
          >
            {columnsView}
          </div>
        </div>
      )}
      </div>
      </div>
      <div ref={parkRef} className="reader-park" hidden aria-hidden="true" />
      {sheetView}
      {fullReader && readerViews.some((view) => view.readerKey === fullReader) ? (
        <div className="reader-full" data-reader-full={fullReader}>
          <ReaderSlot placement={placement} readerKey={fullReader} />
        </div>
      ) : null}
      <ReaderPortals
        placement={placement}
        readers={readerViews}
        now={props.now}
        onFold={foldReaderFor}
        onClose={closeReaderFor}
        onFull={toggleFull}
        onMenu={openReaderMenu}
        onSpawnRetry={props.onSpawnRetry ? spawnRetry : undefined}
      />

      {openMenu && menu.open ? (
        <KanbanMenu anchor={menu.open.anchor} label={openMenu.label} items={openMenu.items} onClose={menu.close} />
      ) : null}
      {stopOpen && stopView ? <StopHostConfirm file={stopView.file} anchor={stopOpen.anchor} onClose={menu.close} /> : null}
      {linkOpen && linkView ? (
        <KanbanPopover
          anchor={linkOpen.anchor}
          label={t("kanban.linkPickerTitle", { conversation: conversationName(linkView) })}
          onClose={menu.close}
          initialFocus="input"
          className="link-picker"
        >
          <div className="head">{t("kanban.linkPickerTitle", { conversation: conversationName(linkView) })}</div>
          <label className="search">
            <input
              type="search"
              placeholder={t("kanban.find")}
              aria-label={t("kanban.find")}
              data-link-search=""
              value={linkQuery}
              onChange={(event) => setLinkQuery(event.target.value)}
            />
          </label>
          {linkCandidates.length ? linkCandidates.map((task) => (
            <button
              key={task.id}
              type="button"
              className="row pick"
              data-link-task={task.id}
              onClick={() => { menu.close(true); linkTo(linkView, task); }}
            >
              <span className="pill" data-status={task.status} style={{ pointerEvents: "none" }}>{statusLabel(t, task.status)}</span>
              <span className="t"><span className="title">{task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled")}</span></span>
            </button>
          )) : <p className="note">{t("kanban.linkPickerEmpty")}</p>}
          <p className="note">{t("kanban.linkPickerNote")}</p>
        </KanbanPopover>
      ) : null}
      {trayOpen ? (
        <HiddenTray
          anchor={trayOpen.anchor}
          groups={model.hiddenGroups}
          offBoard={model.offBoard}
          closed={closedFiles}
          nowMs={props.now * 1000}
          onClose={menu.close}
          onShowGroup={(card) => card.task && showGroup(card.task.id, shortTitle(card), { focus: true })}
          onShowTask={showOnBoard}
          onRestore={restoreConversation}
        />
      ) : null}
      {dragHint ? <div className="drag-hint">{t("kanban.dragHint")}</div> : null}
      {accountOpen && accountOpen.value.kind === "account" ? accountOverlay(accountOpen.value.target, accountOpen.anchor) : null}
      <KanbanReceipts receipts={receipts} onDismiss={dismiss} />
    </div>
    </KanbanDraftContext.Provider>
    </AccountChoiceContext.Provider>
  );
}

type CardHandlers = Pick<
  React.ComponentProps<typeof KanbanCard>,
  | "onToggleCollapsed" | "onStatusMenu" | "onCardMenu" | "onKey" | "onPointerDown" | "onOpenMember" | "onOpenStage" | "onFocusCard" | "onOpenConversations"
  | "onStartEdit" | "onEditDraft" | "onCommitEdit" | "onCancelEdit" | "onRetryEdit" | "onDiscardEdit" | "onUseTheirs" | "onKeepMine" | "onHide"
  | "graphChoices" | "onToggleGraph" | "onOpenAttempt"
  | "drafts" | "pipelinePorts" | "onOpenSheet" | "onPipelineMenu" | "onStagePanelFold" | "onStagePanelClose" | "onStagePanelMenu" | "onAddAgent"
>;

function KanbanColumnView({ status, model, mode, activeTab, filtering, collapsed, nowMs, pendingIds, editing, failedEdits, incomingEdits, onHideIdle, reading, readerKeysByCard, panelsByCard, actingByCard, placement, newTask, onColumnMenu, cardProps }: {
  status: TaskStatus;
  /** `+ Task`'s inline card, drawn first in Inbox. */
  newTask: ReactNode;
  editing: ReadonlyMap<string, { field: EditField; draft: string }>;
  failedEdits: ReadonlyMap<string, { field: EditField; draft: string; message: string }>;
  incomingEdits: ReadonlyMap<string, { field: EditField; value: string }>;
  onHideIdle: () => void;
  reading: boolean;
  readerKeysByCard: ReadonlyMap<string, string>;
  panelsByCard: ReadonlyMap<string, string>;
  actingByCard: ReadonlyMap<string, string>;
  placement: ReaderPlacement;
  model: KanbanModel;
  mode: KanbanLayoutMode;
  activeTab: TaskStatus;
  filtering: boolean;
  collapsed: ReadonlySet<string>;
  nowMs: number;
  pendingIds: { pending(id: string): boolean };
  onColumnMenu: (anchor: HTMLElement) => void;
  cardProps: CardHandlers;
}) {
  const { t } = useLocale();
  const column = model.columns[status];
  const shown = column.shown;
  const renderCard = (card: KanbanCardModel) => (
    <KanbanCard
      key={card.id}
      card={card}
      status={card.status}
      pending={card.task ? pendingIds.pending(card.task.id) : false}
      collapsed={collapsed.has(card.id)}
      nowMs={nowMs}
      readerKeys={readerKeysByCard.get(card.id) ?? ""}
      stagePanels={panelsByCard.get(card.id) ?? ""}
      acting={actingByCard.get(card.id) ?? ""}
      placement={placement}
      editing={editing.get(card.id) ?? null}
      failedEdit={failedEdits.get(card.id) ?? null}
      incomingEdit={incomingEdits.get(card.id) ?? null}
      {...cardProps}
    />
  );
  // Keep the existing idle divider only around a trailing idle suffix. It
  // must never move an older or unknown-work card above newer execution.
  let split = shown.length;
  if (status === "assigned") while (split > 0 && shown[split - 1]!.idle) split -= 1;
  const active = shown.slice(0, split);
  const idle = shown.slice(split);
  const unlinked = status === "inbox" ? model.unlinkedShown : [];
  const empty = shown.length === 0 && unlinked.length === 0 && !newTask;
  return (
    <section
      className={`column${mode === "tabs" && activeTab === status ? " active" : ""}${reading ? " reading" : ""}`}
      data-status={status}
      id={`kb-col-${status}`}
      aria-labelledby={`kb-h-${status}`}
      role={mode === "tabs" ? "tabpanel" : "region"}
    >
      <div className="col-head">
        <h2 id={`kb-h-${status}`}>{statusLabel(t, status)}</h2>
        <span className="n num">{filtering ? t("kanban.columnCount", { shown: shown.length, total: column.cards.length }) : column.cards.length}</span>
        {column.working ? <span className="live num">{t("kanban.columnWorking", { count: column.working })}</span> : null}
        {column.needsYou ? <span className="needs num">{t("kanban.columnNeeds", { count: column.needsYou })}</span> : null}
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          aria-label={t("kanban.columnActions", { column: statusLabel(t, status) })}
          aria-haspopup="menu"
          data-colmenu={status}
          onClick={(event) => onColumnMenu(event.currentTarget)}
        >
          <MoreGlyph />
        </button>
      </div>
      <div className="col-body" data-status={status}>
        {newTask}
        {empty ? (
          <div className="empty">
            <strong>{filtering ? t("kanban.noMatch") : t(`kanban.empty.${status}.title`)}</strong>
            <span>{filtering ? t("kanban.noMatchHint") : t(`kanban.empty.${status}.body`)}</span>
          </div>
        ) : null}
        {active.map(renderCard)}
        {idle.length ? (
          <>
            <div className="divider">
              <span role="separator" aria-label={t("kanban.idleAria", { count: idle.length })}>{t("kanban.idleDivider", { count: idle.length })}</span>
              {idle.some((card) => card.task && !card.holdsSeat) ? (
                <button type="button" data-hide-idle="" title={t("kanban.hideIdleWhy")} onClick={onHideIdle}>{t("kanban.hideIdleShort")}</button>
              ) : null}
            </div>
            {idle.map(renderCard)}
          </>
        ) : null}
        {unlinked.length ? (
          <>
            <div className="divider" role="separator" title={t("kanban.notOnTaskHint")}>
              <span>{t("kanban.notOnTask", { count: unlinked.length })}</span>
            </div>
            {unlinked.map(renderCard)}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** A card whose column changed flies there as a clone above the board, so no
    column's scroll box clips it (prototype `fly`). */
function fly(element: HTMLElement, from: DOMRect, root: HTMLElement): void {
  const destination = element.getBoundingClientRect();
  const body = element.closest(".col-body")?.getBoundingClientRect();
  let target = { left: destination.left, top: destination.top, width: destination.width, height: destination.height, offscreen: false };
  if (!destination.width) target = { left: from.left, top: from.top, width: from.width, height: 40, offscreen: true };
  else if (body && destination.top > body.bottom - 20) target = { left: destination.left, top: body.bottom - 40, width: destination.width, height: 40, offscreen: true };
  else if (body && destination.bottom < body.top + 20) target = { left: destination.left, top: body.top, width: destination.width, height: 40, offscreen: true };
  const ghost = element.cloneNode(true) as HTMLElement;
  /* An open reader stays where it is: the flight carries the card's face. */
  ghost.querySelectorAll(".reader-slot").forEach((slot) => slot.replaceChildren());
  ghost.classList.add("flying");
  ghost.classList.remove("flash", "landing", "moved-static");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.removeAttribute("data-id");
  ghost.removeAttribute("tabindex");
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, maxHeight: `${Math.max(from.height, 60)}px` });
  root.appendChild(ghost);
  element.classList.add("landing");
  const duration = 420;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ghost.style.transition = `left ${duration}ms var(--ease-standard), top ${duration}ms var(--ease-standard), width ${duration}ms var(--ease-standard), max-height ${duration}ms var(--ease-standard), opacity ${duration}ms`;
    ghost.style.left = `${target.left}px`;
    ghost.style.top = `${target.top}px`;
    ghost.style.width = `${target.width}px`;
    ghost.style.maxHeight = `${Math.max(target.height, 60)}px`;
    if (target.offscreen) ghost.style.opacity = "0";
  }));
  setTimeout(() => {
    ghost.remove();
    element.classList.remove("landing", "landed");
    void element.offsetWidth;
    element.classList.add("landed");
  }, duration + 30);
}

