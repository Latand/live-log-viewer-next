import { accountIdFromPath } from "@/lib/accounts/badge";
import { activeCardMigration } from "@/lib/accounts/migration";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { attentionId, blockingStuckDelivery, buildAttentionQueue, openBridgeAsk, stalledAttention } from "../attention";
import { isAuxTask, isChildConversation, isConversation, isSubagent, projectKey } from "../projectModel";
import { turnIsRunning, turnLeftOpen } from "../turnDuration";
import { workingSince } from "../workingSince";

/*
 * What the phone's board shows, as one pure projection (issue #1439, lane 2;
 * docs/design/mobile-v2/README.md §4.1, §4.2).
 *
 * The board is the desktop switchboard's triage grouping — Needs you, Working,
 * Recent — with the orchestrator seat first, the pipelines summary above
 * Working while any pipeline is active, and Recent capped at three rows. A
 * conversation's state is computed ONCE here, by the design's precedence
 *
 *     killed > stalled > limit > held > waiting > working > returned > done
 *
 * (offline and degraded are screen-level and live in the shell's banner slot),
 * and every phone surface renders that one answer: a badge on the rows that
 * need the operator, a phrase in the meta line otherwise.
 *
 * Nothing here invents a lifecycle. Each branch names the authority the board
 * already trusts: the kill is the process state read together with the turn
 * it left behind (a host stopped after its turn settled is a finished
 * conversation, not a killed one — #1487), «stalled» and «waiting» are
 * the attention queue's own signals (`attentionId`, so the bar's badge and
 * these rows cannot count different things), «limit» is the rate-limit wall,
 * «held» is the account-switch delivery fence read exactly as the card status
 * reads it, and «working» is the open-turn condition the working spinner
 * paints from, measured from the anchor that spinner counts with.
 *
 * It is i18n-free on purpose: it answers with facts and numbers, and the
 * component turns them into the operator's words.
 */

/** The eight conversation states, in precedence order. */
export type MobileRowStateKey =
  | "killed"
  | "stalled"
  | "limit"
  | "held"
  | "waiting"
  | "working"
  | "returned"
  | "done";

/** The three sections of the board; the switcher and the swipe read the same. */
export type MobileBoardSection = "needs" | "working" | "recent";

/** The trailing badge of a row that needs the operator. */
export type MobileRowBadge = "question" | "plan" | "decision" | "attention" | "stalled" | "limit";

export type MobileRowDot = "success" | "warning" | "danger" | "accent" | "neutral";

export interface MobileRowState {
  key: MobileRowStateKey;
  section: MobileBoardSection;
  dot: MobileRowDot;
  /** The 3 px left edge; only a row that needs the operator carries one. */
  edge: "warning" | "danger" | null;
  badge: MobileRowBadge | null;
  /** Seconds behind the state phrase: waiting for, stalled for, working, age. */
  seconds: number | null;
  /** Messages queued behind a held delivery. */
  held: number;
  /** Epoch seconds the blocked account's window reopens, when the engine says. */
  resetAt: number | null;
  /** The account the wall belongs to, when the read names one; the limit row
      reads «Main resets 16:40» (README §4.2), so both halves travel together. */
  account: string | null;
}

const NEEDS: ReadonlySet<MobileRowStateKey> = new Set(["stalled", "limit", "waiting"]);
const WORKING: ReadonlySet<MobileRowStateKey> = new Set(["held", "working"]);

function sectionOf(key: MobileRowStateKey): MobileBoardSection {
  if (NEEDS.has(key)) return "needs";
  if (WORKING.has(key)) return "working";
  return "recent";
}

/** Epoch seconds an ISO timestamp names, or null when it does not parse. */
function isoSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** How long the operator has been owed an answer — the same instant the
    attention queue freezes as its sort key, so the row and the queue agree. */
function waitingSince(file: FileEntry, now: number): number {
  const ask = openBridgeAsk(file, now);
  const askAt = ask ? isoSeconds(ask.at) : null;
  if (askAt !== null) return askAt;
  if (file.pendingQuestion) return isoSeconds(file.pendingQuestion.askedAt) ?? file.mtime;
  if (file.waitingInput) return file.waitingInput.since;
  return blockingStuckDelivery(file, now) ?? file.mtime;
}

function waitingBadge(file: FileEntry, now: number): MobileRowBadge {
  if (openBridgeAsk(file, now)) return "decision";
  if (file.pendingQuestion) return file.pendingQuestion.kind === "plan" ? "plan" : "question";
  if (file.waitingInput) return "question";
  return "attention";
}

function heldDeliveries(file: FileEntry): number {
  return activeCardMigration(file.migration, accountIdFromPath(file.path))?.heldDeliveries ?? 0;
}

/**
 * The one state of one conversation, by the design's precedence. `now` is in
 * epoch seconds, like every other clock the board reads.
 */
export function mobileRowState(file: FileEntry, now: number = Date.now() / 1000): MobileRowState {
  const bits = (over: Partial<MobileRowState> & { key: MobileRowStateKey }): MobileRowState => ({
    section: sectionOf(over.key),
    dot: "neutral",
    edge: null,
    badge: null,
    seconds: null,
    held: 0,
    resetAt: null,
    account: null,
    ...over,
  });
  /* `proc === "killed"` is two outcomes, not one (#1487). A host that died
     while its turn was open is the zombie the liveness snapshot reports as
     `host_gone_turn_open`, and the one row worth the danger dot. A host
     stopped AFTER its turn settled — `host_gone_turn_settled` — is how every
     finished stage ends: it falls through to the ordinary reading of a
     finished conversation, in the neutral tone, so the alarming word keeps
     meaning something when it does appear. */
  if (file.proc === "killed" && turnLeftOpen(file)) return bits({ key: "killed", dot: "danger", seconds: Math.max(0, now - file.mtime) });
  if (stalledAttention(file, now)) {
    return bits({ key: "stalled", dot: "danger", edge: "danger", badge: "stalled", seconds: Math.max(0, now - file.mtime) });
  }
  if (file.rateLimit) {
    return bits({
      key: "limit",
      dot: "warning",
      edge: "warning",
      badge: "limit",
      resetAt: file.rateLimit.resetAt ?? null,
      account: file.rateLimit.accountId ?? null,
      seconds: Math.max(0, now - file.mtime),
    });
  }
  const held = heldDeliveries(file);
  if (held > 0) return bits({ key: "held", dot: "warning", held });
  if (attentionId(file, now) !== null) {
    return bits({ key: "waiting", dot: "warning", edge: "warning", badge: waitingBadge(file, now), seconds: Math.max(0, now - waitingSince(file, now)) });
  }
  /* A dead host runs nothing, whatever freshness the transcript still carries. */
  if (file.proc !== "killed" && turnIsRunning(file)) {
    const since = workingSince(file);
    return bits({ key: "working", dot: "success", seconds: since === null ? null : Math.max(0, now - since / 1000) });
  }
  if (file.activity === "recent") return bits({ key: "returned", dot: "accent", seconds: Math.max(0, now - file.mtime) });
  return bits({ key: "done", dot: "neutral", seconds: Math.max(0, now - file.mtime) });
}

/**
 * What the agent is doing right now, for the meta line of a working row: its
 * own plan step, else the goal it declared. Both are the agent's words about
 * the work in flight; neither is invented here, and a conversation that
 * published neither gets no fragment rather than a guess.
 */
export function nowFragment(file: FileEntry): string | null {
  const current = file.plan?.current?.trim();
  if (current) return current;
  const objective = file.goal?.status === "active" ? file.goal.objective?.trim() : null;
  return objective ? objective : null;
}

/**
 * When the conversation was launched, in epoch seconds, or null when nothing
 * durable names it (#1487: the operator wants every row to say when a thing
 * was started, not only how long since it last moved). The transcript
 * header's own creation time first; before a transcript exists, the launch's
 * admission — the same instant the working timer counts from in the starting
 * window.
 */
export function launchedAt(file: FileEntry): number | null {
  const started = isoSeconds(file.sessionStartedAt);
  if (started !== null) return started;
  const launch = file.spawn ?? file.launch ?? null;
  const admitted = launch?.admittedAt ?? launch?.promptAt;
  return typeof admitted === "number" && Number.isFinite(admitted) ? admitted / 1000 : null;
}

export interface MobileBoardConversation {
  file: FileEntry;
  path: string;
  title: string;
  state: MobileRowState;
  /** The agent's current step, on a working row. */
  now: string | null;
  /** Epoch seconds the conversation was launched, when known; the row ends
      with «started 3h ago» so the state's own age and the launch both read. */
  launchedAt: number | null;
  crowned: boolean;
}

export interface MobileBoardPipelineRow {
  pipeline: Pipeline;
  id: string;
  task: string;
  /** 1-based position of the cursor stage, and how many stages there are. */
  stage: number;
  total: number;
  /** The cursor stage as the pipeline declares it. The row says the stage in
      the operator's words, and the one derivation for that (`stageChipLabel`:
      the role's name, «review loop» for a loop, the id for a role-less stage)
      is i18n-bound, so the stage travels and the component names it. */
  stageRef: PipelineStage | null;
  /** The stage's last round returned a `fail` verdict — the reason most of
      these rows are in the queue at all, and the one outcome word the badge
      («needs a decision») does not already say. */
  stageFailed: boolean;
  /** Findings the failing round reported, when the verdict carried any. */
  findings: number | null;
  /** Seconds since the pipeline stopped and asked for the operator. */
  seconds: number | null;
}

export type MobileNeedsYouItem =
  | ({ kind: "conversation" } & MobileBoardConversation)
  | ({ kind: "pipeline" } & MobileBoardPipelineRow);

export interface MobilePipelinesSummary {
  total: number;
  active: number;
  needsDecision: number;
  completed: number;
}

export interface MobileBoardModel {
  /** Conversations and pipelines that need the operator, oldest signal first. */
  needsYou: MobileNeedsYouItem[];
  working: MobileBoardConversation[];
  /** Capped at three rows (README §4.1); `recentTotal` is how many there are. */
  recent: MobileBoardConversation[];
  recentTotal: number;
  pipelines: MobilePipelinesSummary | null;
  /** The pipelines row sits above Working while any pipeline is active, so ten
      working lanes cannot push it past the fold. */
  pipelinesFirst: boolean;
  /** The bar's badge count: the Needs-you rows, conversations and pipelines. */
  attentionCount: number;
}

/** How many Recent rows the board shows before «All conversations · n ›». */
export const RECENT_CAP = 3;

const ACTIVE_PIPELINE_STATES: ReadonlySet<Pipeline["state"]> = new Set(["running", "provisioning", "paused"]);

/** The pipelines this board counts: everything but the closed and the hidden. */
function boardPipelines(pipelines: readonly Pipeline[]): Pipeline[] {
  return pipelines.filter((pipeline) => pipeline.state !== "closed" && pipeline.state !== "draft" && !pipeline.hiddenAt);
}

function pipelineRow(pipeline: Pipeline, now: number): MobileBoardPipelineRow {
  const stageId = pipeline.cursor?.stageId ?? null;
  const index = stageId ? pipeline.stages.findIndex((stage) => stage.id === stageId) : -1;
  const stage = index >= 0 ? pipeline.stages[index] : null;
  const attempts = stageId ? pipeline.runs.find((run) => run.stageId === stageId)?.attempts ?? [] : [];
  const last = attempts.length ? attempts[attempts.length - 1] : null;
  const findings = last?.verdict?.findings?.length ?? null;
  const at = isoSeconds(last?.completedAt ?? last?.startedAt ?? pipeline.createdAt);
  return {
    pipeline,
    id: pipeline.id,
    task: cleanTitle(pipeline.task, 90),
    stage: index >= 0 ? index + 1 : pipeline.stages.length,
    total: pipeline.stages.length,
    stageRef: stage ?? null,
    stageFailed: last?.verdict?.status === "fail",
    findings,
    seconds: at === null ? null : Math.max(0, now - at),
  };
}

/**
 * The pipelines of one project that are waiting on the operator, as queue rows.
 *
 * Exported because the badge, the queue sheet and the board's Needs-you section
 * are one list (README §4.1, §4.6): the bar reads this to count, the sheet
 * reads it to list, and the board reads it through `buildMobileBoard`. Three
 * readers, one answer.
 */
export function needsDecisionPipelineRows(
  pipelines: readonly Pipeline[],
  project: string,
  now: number = Date.now() / 1000,
): MobileBoardPipelineRow[] {
  return boardPipelines(pipelines)
    .filter((pipeline) => pipeline.project === project && pipeline.state === "needs_decision")
    .map((pipeline) => pipelineRow(pipeline, now));
}

/** A conversation the phone board may list: no background task, no subagent
    (children open from the feed, README §6), no archived predecessor and no
    superseded round — the successor is the row that carries that work. */
export function isBoardConversation(file: FileEntry): boolean {
  if (isAuxTask(file) || isSubagent(file)) return false;
  if (file.migratedTo || file.supersededBy) return false;
  return isConversation(file) || isChildConversation(file);
}

export interface MobileBoardInput {
  files: readonly FileEntry[];
  pipelines: readonly Pipeline[];
  project: string;
  /** The seat's transcript: it is the card above the sections, never a row. */
  seatPath?: string | null;
  /** Closed cards and archived conversations stay off the board. */
  hidden?: ReadonlySet<string>;
  archived?: ReadonlySet<string>;
  /** Crowned conversations wear the mark on their row. */
  crowned?: ReadonlySet<string>;
  now?: number;
}

const EMPTY: ReadonlySet<string> = new Set();

export function buildMobileBoard({
  files,
  pipelines,
  project,
  seatPath = null,
  hidden = EMPTY,
  archived = EMPTY,
  crowned = EMPTY,
  now = Date.now() / 1000,
}: MobileBoardInput): MobileBoardModel {
  const rows: MobileBoardConversation[] = [];
  for (const file of files) {
    if (projectKey(file) !== project) continue;
    if (file.path === seatPath) continue;
    if (hidden.has(file.path) || archived.has(file.path)) continue;
    if (!isBoardConversation(file)) continue;
    const state = mobileRowState(file, now);
    rows.push({
      file,
      path: file.path,
      title: cleanTitle(file.title, 90),
      state,
      now: state.key === "working" ? nowFragment(file) : null,
      launchedAt: launchedAt(file),
      crowned: crowned.has(file.path),
    });
  }

  /* The queue reads in the attention queue's OWN order — the hard-blocked
     segment first, the stalled tail after it, oldest signal first inside each
     — because §4.6 makes the rows, the bar's badge and the sheet's «Next ›»
     one queue: an order of our own here would walk the operator through the
     same items in a different sequence. `buildAttentionQueue` is the authority
     that decides it, so it is asked rather than imitated. Anything it does not
     rank (nothing today: every «needs» state carries an `attentionId`) falls
     to the end, oldest first. The other two sections read newest first, like
     every recency list here. */
  const rank = new Map<string, number>();
  buildAttentionQueue([...files], now, project).forEach((item, index) => {
    if (!rank.has(item.file.path)) rank.set(item.file.path, index);
  });
  const byWait = (a: MobileBoardConversation, b: MobileBoardConversation) =>
    (b.state.seconds ?? 0) - (a.state.seconds ?? 0) || a.path.localeCompare(b.path);
  const byQueue = (a: MobileBoardConversation, b: MobileBoardConversation) =>
    (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER) || byWait(a, b);
  const byFreshness = (a: MobileBoardConversation, b: MobileBoardConversation) =>
    b.file.mtime - a.file.mtime || a.path.localeCompare(b.path);

  const needsConversations = rows.filter((row) => row.state.section === "needs").sort(byQueue);
  const working = rows.filter((row) => row.state.section === "working").sort(byFreshness);
  const recentRows = rows.filter((row) => row.state.section === "recent").sort(byFreshness);

  const live = boardPipelines(pipelines).filter((pipeline) => pipeline.project === project);
  const needsPipelines = needsDecisionPipelineRows(pipelines, project, now);
  const active = live.filter((pipeline) => ACTIVE_PIPELINE_STATES.has(pipeline.state));
  const completed = live.filter((pipeline) => pipeline.state === "completed");

  const needsYou: MobileNeedsYouItem[] = [
    ...needsConversations.map((row) => ({ kind: "conversation" as const, ...row })),
    ...needsPipelines.map((row) => ({ kind: "pipeline" as const, ...row })),
  ];

  return {
    needsYou,
    working,
    recent: recentRows.slice(0, RECENT_CAP),
    recentTotal: recentRows.length,
    pipelines: live.length ? { total: live.length, active: active.length, needsDecision: needsPipelines.length, completed: completed.length } : null,
    pipelinesFirst: active.length > 0,
    attentionCount: needsYou.length,
  };
}
