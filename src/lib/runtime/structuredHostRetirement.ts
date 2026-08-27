import fs from "node:fs";
import path from "node:path";

import { agentRegistry, type AgentHostStatus, type ProcessIdentity, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { activeOrchestratorSeatsOrUnknown } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { ProcessMemory } from "@/lib/proc/types";
import type { StructuredHostKillRef } from "@/lib/resources";
import { RESOURCE_STRUCTURED_HOST_LIMIT } from "@/lib/types";

import { durableRuntimeEventTailSeq } from "./eventStore";
import type { HandoffRow } from "./handoffQueue";
import { handoffQueue } from "./handoffQueueStore";
import { blockingHostActivityFlags } from "./hostActivityFlags";
import {
  hasStructuredDeliveryHost,
  structuredDeliveryHostForConversation,
  structuredDeliveryPublicationState,
} from "./structuredDeliveryController";
import {
  terminateStructuredHostTree,
  type StructuredHostTerminationOutcome,
} from "./structuredHostControl";
import { realtimeBoundConversationIds } from "./voiceViewBinding";

/**
 * Automatic retirement of finished and idle structured hosts (#747).
 *
 * A structured host is created for a conversation and, until now, never ended:
 * the headless process reaper excludes every engine owner unconditionally, and
 * the release path is reachable from spawn failure, recovery, reconfigure and
 * account migration — never from a conversation simply finishing. The result
 * was 65 live hosts on one machine, spawns failing outright, and a manual sweep
 * that matched `/proc/<pid>/cwd` against closed pipelines by hand.
 *
 * Residency buys nothing: resumability comes from the on-disk transcript and a
 * host is restarted with an explicit resume of the stored session. So what a
 * retirement must protect is not the process but everything the process still
 * owes — an unfinished turn, an unanswered question, a queued message, a spawn
 * nobody has settled, an event tail the registry has not caught up with. That
 * is what {@link structuredHostRetirementVerdict} is: a conjunction where every
 * clause is a thing that would be lost, and where an unknown answer refuses,
 * because an unestablished fact is not an idle one.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **Staleness is transcript modification time, never process age.** A
 *   long-lived host still being written to is alive; a young host that has
 *   produced nothing since its last turn is not.
 * - **The tree is terminated, never the process group alone.** Most MCP
 *   children put themselves in their own process group, so a group-only sweep
 *   would strand them and turn a host leak into an orphan leak. The termination
 *   ladder in {@link terminateStructuredHostTree} signals the descendant set by
 *   pid and reuses the identity fence #1203 built, so a retirement can never
 *   reach a replacement host that took the session key since the snapshot.
 * - **This runs in the process that holds the hosts, and nowhere else.**
 *   Ownership of a host and the live transports bound to its conversation are
 *   process-scoped state of the process that bound the structured delivery
 *   queue. Asked anywhere else they answer nothing, not "none", so a sweep
 *   there reads a bound call as unbound and an owned host as orphaned. See
 *   {@link startStructuredHostRetirement}.
 */

/** Conservative default: well past the 2 h the resources dialog offers by
    hand, well inside the 16–25 h the manual sweeps found hosts sitting at. */
const DEFAULT_RETIREMENT_IDLE_HOURS = 6;
/** How long a host may take to honour SIGTERM before its tree is force-killed.
    An unattended sweep can afford to wait far longer than the interactive kill
    does, so a host that is flushing its ledger gets to finish. */
const DEFAULT_RETIREMENT_GRACE_MS = 5_000;
const MAX_RETIREMENT_GRACE_MS = 60_000;
const TERMINATION_DEADLINE_MARGIN_MS = 10_000;
/**
 * Retirements attempted per sweep. Each termination may wait out the grace
 * ladder, so an unbounded batch would let one sweep overrun the next tick.
 * Everything skipped is reported as deferred and picked up by the following
 * one; nothing is lost, it only takes another interval.
 */
const RETIREMENT_BATCH = 8;

const REPORT_FILE = () => statePath("host-retirement-report.json");
const JOURNAL_FILE = () => statePath("host-retirement-journal.ndjson");
const JOURNAL_ROTATE_BYTES = 4 * 1024 * 1024;

/** Receipt states that settle a launch. Anything else still names work whose
    outcome depends on this host being there. */
const TERMINAL_RECEIPT_STATES = new Set(["completed", "failed", "conflicted"]);
/** Held-delivery states that have not reached the conversation yet. */
const UNDELIVERED_HELD_STATES = new Set(["held", "assigned", "delivery-uncertain"]);
/** The only two host states the predicate admits. Every other one — starting,
    live, handoff, unhosted — is either working or mid-transition. */
const RETIRABLE_HOST_STATUSES = new Set<AgentHostStatus>(["idle", "dead"]);

export const STRUCTURED_HOST_RETIREMENT_CLAUSES = [
  "seat-free",
  "turn-settled",
  "attention-settled",
  "host-idle-or-dead",
  "no-active-flags",
  "handoff-queue-drained",
  "no-open-operation",
  "events-flushed",
  "no-realtime-binding",
  "resumable",
  "transcript-idle",
  "process-identity",
] as const;

export type StructuredHostRetirementClause = typeof STRUCTURED_HOST_RETIREMENT_CLAUSES[number];

/** Everything the predicate reads about one host, gathered before any of it is
    judged, so the audit can report the facts alongside the verdict. */
export interface StructuredHostRetirementSubject {
  key: SessionKey;
  keyId: string;
  conversationId: string | null;
  title: string | null;
  role: string | null;
  stage: string | null;
  cwd: string;
  transcriptPath: string;
  process: ProcessIdentity;
  status: AgentHostStatus;
  activeTurnRef: string | null;
  /** Null when no conversation record establishes a turn state. */
  turnBusy: boolean | null;
  pendingAttention: readonly string[];
  activeFlags: readonly string[];
  pendingAction: string | null;
  structuredHostOperationId: string | null;
  undeliveredHandoffEntries: number;
  openOperations: number;
  /** The registry's persisted cursor: the flushed one. */
  eventCursor: number;
  /** The ledger's durable tail: the session's own cursor. Null when the ledger
      exists but could not be read. */
  durableEventTail: number | null;
  /** Null when this process cannot establish whether a live transport is bound
      — a state the sweep refuses on rather than reads as "no call". */
  realtimeBound: boolean | null;
  /** Null when neither the registry nor the durable seat store establishes
      whether this host holds a seat. */
  seat: boolean | null;
  transcriptMtimeMs: number | null;
  observedStartIdentity: string | null;
}

export type StructuredHostRetirementVerdict =
  | { retire: true; passed: StructuredHostRetirementClause[]; startIdentity: string }
  | { retire: false; clause: StructuredHostRetirementClause; reason: string };

/**
 * The conjunction. Clause order is the order of the checks, and the first
 * refusal is the reported one, so a subject that fails several still names a
 * single cause the operator can act on.
 *
 * `seat-free` runs first because it is the clause an unestablished fact fails
 * first: with no conversation record neither the seat nor the turn can be
 * established, and with no readable seat store the live authority itself is
 * silent. An unestablished seat is excluded rather than assumed free — the
 * mistake #1199's review already caught once, and an orchestrator is exactly
 * the host that sits quiet for hours between operator messages, so it would
 * pass every other clause.
 */
export function structuredHostRetirementVerdict(
  subject: StructuredHostRetirementSubject,
  options: { now: number; idleMs: number },
): StructuredHostRetirementVerdict {
  const passed: StructuredHostRetirementClause[] = [];
  const refuse = (clause: StructuredHostRetirementClause, reason: string) =>
    ({ retire: false as const, clause, reason });
  const pass = (clause: StructuredHostRetirementClause) => { passed.push(clause); };

  if (subject.seat === null) {
    return refuse("seat-free", "the host's orchestrator-seat status cannot be established");
  }
  if (subject.seat) return refuse("seat-free", "the host holds a live orchestrator seat");
  pass("seat-free");

  if (subject.activeTurnRef !== null) return refuse("turn-settled", `turn ${subject.activeTurnRef} is in flight`);
  if (subject.turnBusy === null) return refuse("turn-settled", "the host's turn state cannot be established");
  if (subject.turnBusy) return refuse("turn-settled", "the conversation turn has not settled");
  pass("turn-settled");

  if (subject.pendingAttention.length > 0) {
    return refuse("attention-settled", `${subject.pendingAttention.length} question(s) await an operator answer`);
  }
  pass("attention-settled");

  if (!RETIRABLE_HOST_STATUSES.has(subject.status)) {
    return refuse("host-idle-or-dead", `the host status is ${subject.status}`);
  }
  pass("host-idle-or-dead");

  /* Capability advertisements are not activity: every Claude host carries
     `structured-image-v1` (and the multi-agent denial's tool set) for its whole
     life, so reading the raw array refuses every Claude host forever and
     retires nothing at all. Anything the classifier does not recognise still
     counts as activity and still refuses. */
  const activityFlags = blockingHostActivityFlags(subject.activeFlags);
  if (activityFlags.length > 0) {
    return refuse("no-active-flags", `the host is flagged ${activityFlags.join(", ")}`);
  }
  pass("no-active-flags");

  if (subject.undeliveredHandoffEntries > 0) {
    return refuse("handoff-queue-drained", `${subject.undeliveredHandoffEntries} undelivered handoff entr(ies) name this key`);
  }
  pass("handoff-queue-drained");

  if (subject.pendingAction !== null) return refuse("no-open-operation", `a ${subject.pendingAction} action is pending`);
  if (subject.structuredHostOperationId !== null) {
    return refuse("no-open-operation", "a structured host operation is still in flight");
  }
  if (subject.openOperations > 0) {
    return refuse("no-open-operation", `${subject.openOperations} spawn receipt(s) are pending or non-terminal`);
  }
  pass("no-open-operation");

  if (subject.durableEventTail === null) {
    return refuse("events-flushed", "the runtime event ledger tail cannot be read");
  }
  if (subject.eventCursor < subject.durableEventTail) {
    return refuse("events-flushed", `the flushed cursor ${subject.eventCursor} is behind the session's ${subject.durableEventTail}`);
  }
  pass("events-flushed");

  if (subject.realtimeBound === null) {
    return refuse("no-realtime-binding", "whether a realtime session is bound cannot be established here");
  }
  if (subject.realtimeBound) return refuse("no-realtime-binding", "a realtime session is bound to this conversation");
  pass("no-realtime-binding");

  /* Resumability is the whole reason retirement is safe, so it is proven, not
     assumed: the session key IS the resume token, and the transcript it names
     has to be on disk right now. */
  if (subject.transcriptPath === "") return refuse("resumable", "the host names no transcript to resume from");
  if (subject.transcriptMtimeMs === null) return refuse("resumable", "the transcript is not present on disk");
  pass("resumable");

  const idleMs = options.now - subject.transcriptMtimeMs;
  if (idleMs < options.idleMs) {
    return refuse("transcript-idle", `the transcript was written ${Math.max(0, Math.round(idleMs / 1_000))}s ago`);
  }
  pass("transcript-idle");

  /* The fence #1203 built binds the kill to the identity the record stored,
     and only to that. A stored null is not a gap to fill: the hosts write it
     precisely when they concluded their own pid was recycled or unverifiable,
     so substituting today's observation would compare an observation against
     itself and hand an unattended sweep a tree it never identified. Refusing
     costs one leaked host; substituting can cost an unrelated process tree. */
  const startIdentity = subject.process.startIdentity;
  if (startIdentity === null) {
    return refuse("process-identity", `the registry stored no kernel identity for pid ${subject.process.pid}`);
  }
  if (subject.observedStartIdentity === null) {
    return refuse("process-identity", `no kernel identity can be observed for pid ${subject.process.pid}`);
  }
  if (subject.observedStartIdentity !== startIdentity) {
    return refuse("process-identity", `pid ${subject.process.pid} is no longer the recorded host`);
  }
  pass("process-identity");

  return { retire: true, passed, startIdentity };
}

export interface StructuredHostRetirementReclaim {
  rssBytes: number;
  swapBytes: number;
  processes: number;
}

export interface StructuredHostRetirementRecord {
  key: string;
  engine: "claude" | "codex";
  sessionId: string;
  conversationId: string | null;
  title: string | null;
  role: string | null;
  stage: string | null;
  cwd: string;
  /** How long the transcript had been quiet when the sweep decided. */
  idleMs: number;
  /** The clauses that qualified this host, in the order they were checked. */
  passed: StructuredHostRetirementClause[];
  /** How the tree was ended: through the runtime that held the host, by the
      signal ladder, or not at all because it had already exited. */
  via: Extract<StructuredHostTerminationOutcome, { ok: true }>["via"];
  pids: number[];
  reclaimed: StructuredHostRetirementReclaim;
}

export interface StructuredHostRetirementRefusal {
  key: string;
  conversationId: string | null;
  clause: StructuredHostRetirementClause;
  reason: string;
  /** Set when the host qualified on evaluation and stopped qualifying in the
      re-check taken one step before the signal — a turn that started, a seat
      that was taken, a message that arrived while earlier candidates in the
      same sweep were being terminated. */
  changed?: true;
}

export interface StructuredHostRetirementFailure {
  key: string;
  conversationId: string | null;
  error: string;
  remaining: number[];
}

export interface StructuredHostRetirementReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  idleHours: number;
  /** Hosts the sweep looked at. Zero is a real answer, and it is what
      distinguishes a sweep that found nothing from a sweep that never ran. */
  evaluated: number;
  /** Qualifying hosts left for the next tick by the per-sweep batch bound. */
  deferred: number;
  /** Why the sweep evaluated nothing at all: this process does not hold the
      structured hosts, so it can establish neither their live transports nor
      their ownership. Null when the sweep ran. */
  standDown: "rebinding" | "unbound" | null;
  retired: StructuredHostRetirementRecord[];
  refused: StructuredHostRetirementRefusal[];
  failed: StructuredHostRetirementFailure[];
  reclaimed: StructuredHostRetirementReclaim;
}

export interface StructuredHostRetirementDependencies {
  publicationState?: () => "ready" | "rebinding" | "unbound";
  snapshot?: () => RegistryFile;
  handoffRows?: () => readonly HandoffRow[];
  durableEventTail?: (sessionId: string) => number | null;
  realtimeBound?: (conversationId: string) => boolean | null;
  /** Null when the durable seat store could not be established — the sweep
      refuses rather than reading silence as "no seats". */
  orchestratorSeatConversations?: () => ReadonlySet<string> | null;
  transcriptStat?: (pathname: string) => { mtimeMs: number } | null;
  processIdentity?: (pid: number) => string | null;
  processMemory?: (pids: Iterable<number>) => Map<number, ProcessMemory>;
  ppidMap?: () => Map<number, number>;
  owned?: (key: SessionKey) => boolean;
  terminate?: (ref: StructuredHostKillRef) => Promise<StructuredHostTerminationOutcome>;
  record?: (report: StructuredHostRetirementReport) => void;
  now?: () => number;
  idleMs?: number;
  graceMs?: number;
  batch?: number;
}

/** Idle threshold for the automatic sweep, or null when the operator has
    turned it off with `LLV_HOST_RETIREMENT_IDLE_HOURS=0`. */
export function structuredHostRetirementIdleMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  const raw = env.LLV_HOST_RETIREMENT_IDLE_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETIREMENT_IDLE_HOURS * 3_600_000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    console.warn(`[host retirement] LLV_HOST_RETIREMENT_IDLE_HOURS is not a duration; using ${DEFAULT_RETIREMENT_IDLE_HOURS}h`);
    return DEFAULT_RETIREMENT_IDLE_HOURS * 3_600_000;
  }
  return hours === 0 ? null : hours * 3_600_000;
}

export function structuredHostRetirementGraceMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  /* Unset and blank are the same statement — "the operator said nothing" —
     and `Number("")` is 0, which would silently mean "escalate to SIGKILL
     immediately" and lose the graceful window the default exists for. */
  const raw = env.LLV_HOST_RETIREMENT_GRACE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETIREMENT_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RETIREMENT_GRACE_MS;
  return Math.min(value, MAX_RETIREMENT_GRACE_MS);
}

function transcriptStat(pathname: string): { mtimeMs: number } | null {
  try {
    const stats = fs.statSync(pathname);
    return stats.isFile() ? { mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Conversations a live voice call or a hosted realtime thread is bound to.
 *
 * Both ledgers are process-scoped, because both describe a transport that does
 * not survive the Viewer — which is exactly why this can only be read from the
 * process that holds the hosts. Asked anywhere else it does not answer "no
 * call", it answers nothing, and null is what the predicate refuses on.
 */
function defaultRealtimeBound(conversationId: string): boolean | null {
  try {
    if (realtimeBoundConversationIds().has(conversationId)) return true;
    const host = structuredDeliveryHostForConversation(conversationId) as
      { currentRealtimeSessionId?: () => string | null } | null;
    return typeof host?.currentRealtimeSessionId === "function"
      ? host.currentRealtimeSessionId() !== null
      : false;
  } catch {
    return null;
  }
}

/**
 * Conversations holding a live orchestrator seat, or null when the durable seat
 * store could not be established.
 *
 * The reader the authority path uses answers an unreadable file as an EMPTY
 * one, because authority fails closed on an absent seat. Here the same silence
 * would mean the opposite — every live orchestrator reads as seat-free, and an
 * orchestrator is precisely the host that sits quiet for hours between operator
 * messages, so it passes every other clause. This reads the source that can
 * still say "unknown", and unknown refuses.
 */
function defaultOrchestratorSeatConversations(): ReadonlySet<string> | null {
  let active: ReturnType<typeof activeOrchestratorSeatsOrUnknown>;
  try {
    active = activeOrchestratorSeatsOrUnknown();
  } catch {
    return null;
  }
  if (active === null) return null;
  const seats = new Set<string>();
  for (const seat of active) {
    if (seat.conversationId) seats.add(seat.conversationId);
  }
  return seats;
}

function atomicWrite(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

/**
 * What the journal keeps from one sweep.
 *
 * Every action is kept whole — which host, why it qualified, what it
 * reclaimed — while refusals are kept as a count per clause. A machine holding
 * 65 hosts refuses 65 times a minute, and writing each of those out in full
 * would push the actions that matter out of a rotated journal within hours. The
 * last sweep's refusals stay in full in the report file beside it.
 */
export function structuredHostRetirementJournalRecord(
  report: StructuredHostRetirementReport,
): Omit<StructuredHostRetirementReport, "refused"> & { refusedByClause: Record<string, number> } {
  const { refused, ...rest } = report;
  const refusedByClause: Record<string, number> = {};
  for (const item of refused) refusedByClause[item.clause] = (refusedByClause[item.clause] ?? 0) + 1;
  return { ...rest, refusedByClause };
}

/**
 * The audit trail. Every sweep appends a journal record whether or not it
 * retired anything — a sweep that found nothing must be distinguishable from a
 * sweep that never ran — and the console only speaks when the sweep acted, so
 * a machine holding live agent sessions is not narrated at once a minute.
 */
function recordRetirementReport(report: StructuredHostRetirementReport): void {
  try {
    atomicWrite(REPORT_FILE(), report);
  } catch (error) {
    console.error("[host retirement] report could not be written", error);
  }
  try {
    const filename = JOURNAL_FILE();
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(filename).size > JOURNAL_ROTATE_BYTES) fs.renameSync(filename, `${filename}.1`);
    } catch { /* first write */ }
    fs.appendFileSync(filename, `${JSON.stringify(structuredHostRetirementJournalRecord(report))}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("[host retirement] journal could not be appended", error);
  }
  for (const retired of report.retired) {
    console.warn(`[host retirement] retired ${retired.key} (${retired.role ?? "no role"}, idle ${Math.round(retired.idleMs / 60_000)}m) via ${retired.via}: ${retired.reclaimed.processes} process(es), ${Math.round(retired.reclaimed.rssBytes / 1_048_576)} MiB resident + ${Math.round(retired.reclaimed.swapBytes / 1_048_576)} MiB swapped reclaimed`);
  }
  for (const failure of report.failed) {
    console.warn(`[host retirement] left ${failure.key} intact: ${failure.error}`);
  }
}

/**
 * Per-sweep counts of the work a key still owes, indexed once instead of
 * rescanned per host: with 512 hosts and a registry holding every receipt the
 * machine has ever issued, a per-host scan is quadratic on a pass that runs
 * once a minute.
 *
 * A row is counted under exactly one token — its session key when it names one,
 * its conversation otherwise — so a candidate that sums both tokens never
 * double-counts the same row.
 */
class RetirementWorkIndex {
  private readonly counts = new Map<string, number>();

  private add(token: string | null): void {
    if (token !== null) this.counts.set(token, (this.counts.get(token) ?? 0) + 1);
  }

  addKey(keyId: string): void { this.add(`key:${keyId}`); }
  addConversation(conversationId: string | null): void {
    this.add(conversationId === null ? null : `conv:${conversationId}`);
  }

  count(keyId: string, conversationId: string | null): number {
    return (this.counts.get(`key:${keyId}`) ?? 0)
      + (conversationId === null ? 0 : this.counts.get(`conv:${conversationId}`) ?? 0);
  }
}

/**
 * Messages a key still owes a delivery for. Two durable places hold them and
 * both are the same clause: the handoff queue's own rows, and the registry's
 * held deliveries — a message accepted for a conversation whose host had not
 * taken it yet. Retiring under either strands the message.
 *
 * What blocks is an UNDELIVERED entry, in every status. A row's status
 * describes where its ownership transfer stands, not whether a message is
 * outstanding: `collectHandoffCandidates` enqueues one row per hosted
 * conversation and a claim leaves an idle-turn row `claimed` until the next
 * hand-over, so a status test would refuse the entire hosted population the
 * moment the queue had a writer. The unreplayed pending delivery is the thing
 * a retirement would strand, so that is the whole test.
 */
function undeliveredHandoffIndex(rows: readonly HandoffRow[], file: RegistryFile): RetirementWorkIndex {
  const index = new RetirementWorkIndex();
  for (const row of rows) {
    const replayed = new Set(row.replayedDeliveryIds ?? []);
    if (!(row.pendingDeliveries ?? []).some((delivery) => !replayed.has(delivery.deliveryId))) continue;
    if (row.engine === "claude" || row.engine === "codex") index.addKey(`${row.engine}:${row.engineSessionId}`);
    else index.addConversation(row.conversationId);
  }
  for (const delivery of Object.values(file.heldDeliveries ?? {})) {
    if (UNDELIVERED_HELD_STATES.has(delivery.state)) index.addConversation(delivery.conversationId);
  }
  return index;
}

/** Spawn receipts that named a key or its conversation and have not settled.
    Retiring under one strands the launch it is waiting on. */
function openOperationIndex(file: RegistryFile): RetirementWorkIndex {
  const index = new RetirementWorkIndex();
  for (const receipt of Object.values(file.receipts ?? {})) {
    if (TERMINAL_RECEIPT_STATES.has(receipt.state)) continue;
    if (receipt.key !== null) index.addKey(sessionKeyId(receipt.key));
    else index.addConversation(receipt.conversationId);
  }
  return index;
}

/**
 * Everything one evaluation of the predicate needs that comes out of durable
 * state, indexed once. Rebuilt whenever the sweep re-reads, because a re-check
 * whose queue and receipts come from the planning pass would re-check nothing.
 */
interface RetirementInputs {
  file: RegistryFile;
  conversationsBySession: Map<string, RegistryFile["conversations"][string]>;
  undelivered: RetirementWorkIndex;
  openOperations: RetirementWorkIndex;
  /** The seat file is one read per pass, not one per host: a candidate list is
      bounded but not small, and this is a file. Null when it could not be read
      at all, which is a refusal rather than an empty set. */
  seatConversations: ReadonlySet<string> | null;
}

/** Per-host facts that come from a durable read the whole pass shares. */
interface RetirementSources {
  snapshot: () => RegistryFile;
  handoffRows: () => readonly HandoffRow[];
  seatConversations: () => ReadonlySet<string> | null;
}

function retirementInputs(sources: RetirementSources): RetirementInputs {
  const file = sources.snapshot();
  const conversationsBySession = new Map<string, RegistryFile["conversations"][string]>();
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) conversationsBySession.set(generation.id, conversation);
  }
  return {
    file,
    conversationsBySession,
    undelivered: undeliveredHandoffIndex(sources.handoffRows(), file),
    openOperations: openOperationIndex(file),
    seatConversations: sources.seatConversations(),
  };
}

/** The live facts the predicate reads off the machine rather than out of a
    durable store. Every one is re-read on the re-check, because every one of
    them can change under it. */
interface RetirementReaders {
  durableEventTail: (sessionId: string) => number | null;
  realtimeBound: (conversationId: string) => boolean | null;
  transcriptStat: (pathname: string) => { mtimeMs: number } | null;
  processIdentity: (pid: number) => string | null;
}

/** Candidate rows: registry-recorded structured hosts only. */
function retirementCandidates(file: RegistryFile) {
  return Object.values(file.entries)
    .filter((entry) => Boolean(entry.structuredHost?.process)
      && (entry.key.engine === "claude" || entry.key.engine === "codex")
      /* A pane-hosted entry belongs to the tmux lifecycle, not to this one. */
      && entry.host === null)
    .slice(0, RESOURCE_STRUCTURED_HOST_LIMIT);
}

/**
 * Whether this conversation holds a live orchestrator seat, or null when that
 * cannot be established.
 *
 * A registry orchestrator membership is durable evidence on its own. The seat
 * store is the live authority, so when it cannot be read a conversation with no
 * membership row is unknown — never free.
 */
function seatStatus(
  conversationId: string,
  memberships: readonly { kind: string }[],
  seatConversations: ReadonlySet<string> | null,
): boolean | null {
  if (memberships.some((membership) => membership.kind === "orchestrator")) return true;
  if (seatConversations === null) return null;
  return seatConversations.has(conversationId);
}

function retirementSubject(
  entry: RegistryFile["entries"][string],
  inputs: RetirementInputs,
  readers: RetirementReaders,
): StructuredHostRetirementSubject {
  const columns = entry.structuredHost!;
  const hostProcess = columns.process!;
  const key = entry.key as SessionKey & { engine: "claude" | "codex" };
  const keyId = sessionKeyId(key);
  const conversation = inputs.conversationsBySession.get(key.sessionId) ?? null;
  const conversationId = conversation?.id ?? null;
  const memberships = conversation ? inputs.file.memberships[conversation.id] ?? [] : [];
  const pipeline = memberships.find((membership) => membership.kind === "pipeline") ?? null;
  const generation = conversation?.generations.find((candidate) => candidate.id === key.sessionId) ?? null;

  return {
    key,
    keyId,
    conversationId,
    title: generation?.launchProfile.title ?? null,
    role: conversation?.agentRole ?? pipeline?.role ?? generation?.launchProfile.role ?? null,
    stage: pipeline?.stageId ?? pipeline?.slot ?? null,
    cwd: entry.cwd || generation?.launchProfile.cwd || "",
    transcriptPath: entry.artifactPath || "",
    process: hostProcess,
    status: entry.status,
    activeTurnRef: columns.activeTurnRef,
    turnBusy: conversation === null || conversation.turn.state === "unknown"
      ? null
      : conversation.turn.state === "busy",
    pendingAttention: columns.pendingAttention,
    activeFlags: columns.activeFlags,
    pendingAction: entry.pendingAction,
    structuredHostOperationId: entry.structuredHostOperationId ?? null,
    undeliveredHandoffEntries: inputs.undelivered.count(keyId, conversationId),
    openOperations: inputs.openOperations.count(keyId, conversationId),
    eventCursor: columns.eventCursor,
    durableEventTail: readers.durableEventTail(key.sessionId),
    realtimeBound: conversationId === null ? false : readers.realtimeBound(conversationId),
    seat: conversation === null ? null : seatStatus(conversation.id, memberships, inputs.seatConversations),
    transcriptMtimeMs: entry.artifactPath ? readers.transcriptStat(entry.artifactPath)?.mtimeMs ?? null : null,
    observedStartIdentity: readers.processIdentity(hostProcess.pid),
  };
}

/**
 * One pass over every structured host the registry records.
 *
 * Only recorded hosts are candidates. A process the scan finds with no registry
 * row behind it has no conversation, no cursor and no queue to check, so the
 * predicate cannot be applied to it at all — and a sweep that killed what it
 * could not evaluate would be the failure mode this exists to prevent. The
 * runtime container, its supervisors and the Viewer's own chain are never
 * recorded as structured hosts, and {@link terminateStructuredHostTree} refuses
 * the Viewer's own ancestry a second time.
 *
 * Two things about WHERE and WHEN this runs are load-bearing:
 *
 * - **It runs only in the process that holds the hosts.** A voice binding, a
 *   hosted realtime thread and host ownership all live in that process and
 *   nowhere else. Asked from any other process they do not answer "none", they
 *   answer nothing — so a sweep there would read a bound call as unbound and
 *   an owned host as orphaned, skip the graceful lifecycle shutdown entirely
 *   and go straight to signals. `publicationState` is that fence, and it is
 *   checked before a single candidate is read.
 * - **A qualification is re-proved one step before the signal.** The batch
 *   ahead of a candidate may spend a grace ladder each, so its clauses can be
 *   a minute or more old by the time its turn comes. Every volatile fact is
 *   re-read from durable state and from the machine, and a host that stopped
 *   qualifying is reported with the clause that changed instead of killed.
 */
export async function runStructuredHostRetirementSweep(
  dependencies: StructuredHostRetirementDependencies = {},
): Promise<StructuredHostRetirementReport> {
  const now = dependencies.now ?? Date.now;
  const startedAtMs = now();
  /* An off switch must never read as "retire anything idle at all": a direct
     caller with the sweep disabled still gets the conservative interval. */
  const idleMs = dependencies.idleMs
    ?? structuredHostRetirementIdleMs()
    ?? DEFAULT_RETIREMENT_IDLE_HOURS * 3_600_000;
  const graceMs = dependencies.graceMs ?? structuredHostRetirementGraceMs();
  const batch = dependencies.batch ?? RETIREMENT_BATCH;
  const snapshot = dependencies.snapshot ?? (() => agentRegistry().readOnlySnapshot());
  const handoffRows = dependencies.handoffRows ?? (() => {
    try { return handoffQueue().rows(); } catch { return []; }
  });
  const sources: RetirementSources = {
    snapshot,
    handoffRows,
    seatConversations: dependencies.orchestratorSeatConversations ?? defaultOrchestratorSeatConversations,
  };
  const readers: RetirementReaders = {
    durableEventTail: dependencies.durableEventTail ?? ((sessionId: string) => durableRuntimeEventTailSeq(sessionId)),
    realtimeBound: dependencies.realtimeBound ?? defaultRealtimeBound,
    transcriptStat: dependencies.transcriptStat ?? transcriptStat,
    processIdentity: dependencies.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid)),
  };
  const memoryOf = dependencies.processMemory ?? ((pids: Iterable<number>) => procBackend.processMemory(pids));
  const ppids = dependencies.ppidMap ?? (() => procBackend.ppidMap());
  const owned = dependencies.owned ?? hasStructuredDeliveryHost;
  const terminate = dependencies.terminate ?? ((ref: StructuredHostKillRef) => terminateStructuredHostTree(ref, {
    graceMs,
    deadlineMs: graceMs + TERMINATION_DEADLINE_MARGIN_MS,
  }));
  const record = dependencies.record ?? recordRetirementReport;
  const publicationState = dependencies.publicationState ?? structuredDeliveryPublicationState;

  const report: StructuredHostRetirementReport = {
    version: 1,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: "",
    idleHours: idleMs / 3_600_000,
    evaluated: 0,
    deferred: 0,
    standDown: null,
    retired: [],
    refused: [],
    failed: [],
    reclaimed: { rssBytes: 0, swapBytes: 0, processes: 0 },
  };

  const publication = publicationState();
  if (publication !== "ready") {
    /* Not an error and not "nothing to do": this process cannot speak for the
       hosts, so it evaluates none of them. The journal still gets the record,
       because a sweep that stood down must be distinguishable from one that
       never ran. */
    report.standDown = publication;
    report.finishedAt = new Date(now()).toISOString();
    record(report);
    return report;
  }

  const planned = retirementInputs(sources);
  const candidates = retirementCandidates(planned.file);
  report.evaluated = candidates.length;

  const qualified: StructuredHostRetirementSubject[] = [];
  for (const entry of candidates) {
    const subject = retirementSubject(entry, planned, readers);
    const verdict = structuredHostRetirementVerdict(subject, { now: startedAtMs, idleMs });
    if (!verdict.retire) {
      report.refused.push({
        key: subject.keyId,
        conversationId: subject.conversationId,
        clause: verdict.clause,
        reason: verdict.reason,
      });
      continue;
    }
    if (qualified.length >= batch) {
      report.deferred += 1;
      continue;
    }
    qualified.push(subject);
  }

  let parents: Map<number, number> | null = null;
  for (const planning of qualified) {
    /* The re-check. Everything durable is re-read, and so is every fact that
       lives on the machine rather than in the registry: an earlier termination
       in this same sweep may have taken a grace ladder, and the checks that
       admitted this host are that much older than the signal about to be sent
       (the race `structuredHostKillRefusal` exists for on the interactive
       path). A row that vanished in the meantime is nothing to retire. */
    const current = retirementInputs(sources);
    const fresh = current.file.entries[planning.keyId] ?? null;
    if (fresh === null || !fresh.structuredHost?.process) {
      report.refused.push({
        key: planning.keyId,
        conversationId: planning.conversationId,
        clause: "process-identity",
        reason: "the registry no longer records this host",
        changed: true,
      });
      continue;
    }
    const subject = retirementSubject(fresh, current, readers);
    const verdict = structuredHostRetirementVerdict(subject, { now: now(), idleMs });
    if (!verdict.retire) {
      report.refused.push({
        key: subject.keyId,
        conversationId: subject.conversationId,
        clause: verdict.clause,
        reason: verdict.reason,
        changed: true,
      });
      continue;
    }
    const hostProcess = subject.process;

    /* Measured before anything is signalled: a tree that is already gone
       reports nothing, and a reclaim claimed after the kill would be zero. */
    parents ??= ppids();
    const tree = descendantPids(hostProcess.pid, parents);
    const measured = memoryOf(tree);
    const reclaimed: StructuredHostRetirementReclaim = { rssBytes: 0, swapBytes: 0, processes: measured.size };
    for (const usage of measured.values()) {
      reclaimed.rssBytes += usage.rssBytes;
      reclaimed.swapBytes += usage.swapBytes;
    }

    const ref: StructuredHostKillRef = {
      kind: "structured",
      pid: hostProcess.pid,
      startIdentity: verdict.startIdentity,
      engine: subject.key.engine,
      sessionId: subject.key.sessionId,
      conversationId: subject.conversationId,
      seat: subject.seat,
      turnBusy: subject.turnBusy,
      owned: owned(subject.key),
      lastActiveAt: subject.transcriptMtimeMs === null ? null : new Date(subject.transcriptMtimeMs).toISOString(),
    };

    let outcome: StructuredHostTerminationOutcome;
    try {
      outcome = await terminate(ref);
    } catch (error) {
      report.failed.push({ key: subject.keyId, conversationId: subject.conversationId, error: String(error), remaining: [] });
      continue;
    }
    if (!outcome.ok) {
      /* Either the host is retired and its descendants are collected, or the
         attempt is abandoned and the host left intact. The ladder keeps the
         registry row for anything it could not finish, so nothing here is
         half-retired. */
      report.failed.push({ key: subject.keyId, conversationId: subject.conversationId, error: outcome.error, remaining: outcome.remaining });
      continue;
    }
    report.retired.push({
      key: subject.keyId,
      engine: subject.key.engine,
      sessionId: subject.key.sessionId,
      conversationId: subject.conversationId,
      title: subject.title,
      role: subject.role,
      stage: subject.stage,
      cwd: subject.cwd,
      idleMs: subject.transcriptMtimeMs === null ? 0 : startedAtMs - subject.transcriptMtimeMs,
      passed: verdict.passed,
      via: outcome.via,
      pids: outcome.pids,
      reclaimed,
    });
    report.reclaimed.rssBytes += reclaimed.rssBytes;
    report.reclaimed.swapBytes += reclaimed.swapBytes;
    report.reclaimed.processes += reclaimed.processes;
    /* The next candidate's tree is re-derived: this kill changed the table. */
    parents = null;
  }

  report.finishedAt = new Date(now()).toISOString();
  record(report);
  return report;
}

/**
 * The seam behind the timer — the only thing in the Viewer that ends a host
 * without an operator gesture.
 *
 * It is deliberately the whole policy: whether the sweep is enabled at all, and
 * that a failing sweep never blocks the tick around it. The call site is one
 * line so the two cannot drift.
 */
export async function reconcileStructuredHostRetirement(dependencies: {
  env?: Readonly<Record<string, string | undefined>>;
  sweep?: (idleMs: number) => Promise<StructuredHostRetirementReport>;
} = {}): Promise<StructuredHostRetirementReport | null> {
  const idleMs = structuredHostRetirementIdleMs(dependencies.env ?? process.env);
  if (idleMs === null) return null;
  const sweep = dependencies.sweep
    ?? ((value: number) => runStructuredHostRetirementSweep({ idleMs: value }));
  try {
    return await sweep(idleMs);
  } catch (error) {
    console.error("[host retirement] sweep failed", error);
    return null;
  }
}

/**
 * How often the release that owns traffic sweeps.
 *
 * Far slower than the reconciliation controllers, and deliberately so: the
 * default quiet interval is six hours, so a few minutes of latency costs
 * nothing, while every tick reads `/proc` for each recorded host inside the
 * process that is also serving the operator's board.
 */
export const STRUCTURED_HOST_RETIREMENT_INTERVAL_MS = 5 * 60_000;

const retirementHost = globalThis as typeof globalThis & {
  __llvStructuredHostRetirementTimer?: ReturnType<typeof setInterval>;
};

/**
 * Starts the sweep in the process that holds the structured hosts.
 *
 * This is not a free choice of call site. Host ownership, a live voice binding
 * and a hosted realtime thread are all process-scoped state of the process that
 * bound the delivery queue. Swept from the account-migration inventory sidecar
 * — a separate OS process — every one of those reads answers "none" for
 * everything, which turns two clauses of the predicate vacuous and makes the
 * graceful lifecycle shutdown unreachable, so every retirement would go
 * straight to signals. So the sweep starts with the release that owns traffic,
 * like every other controller that speaks for live hosts, and stands down at
 * the top of {@link runStructuredHostRetirementSweep} if it ever finds itself
 * somewhere that cannot answer.
 */
export function startStructuredHostRetirement(ports: {
  scheduleInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  sweep?: () => Promise<unknown>;
  intervalMs?: number;
} = {}): void {
  if (retirementHost.__llvStructuredHostRetirementTimer) return;
  const schedule = ports.scheduleInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const sweep = ports.sweep ?? (() => reconcileStructuredHostRetirement());
  const timer = schedule(() => { void sweep(); }, ports.intervalMs ?? STRUCTURED_HOST_RETIREMENT_INTERVAL_MS);
  timer.unref?.();
  retirementHost.__llvStructuredHostRetirementTimer = timer;
}

/** Test seam: the timer is process-global, so a suite must be able to start
    from an unstarted one without reaching into module internals. */
export function stopStructuredHostRetirement(): void {
  const timer = retirementHost.__llvStructuredHostRetirementTimer;
  if (timer) clearInterval(timer);
  retirementHost.__llvStructuredHostRetirementTimer = undefined;
}
