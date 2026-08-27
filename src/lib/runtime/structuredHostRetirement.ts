import fs from "node:fs";
import path from "node:path";

import { agentRegistry, type AgentHostStatus, type ProcessIdentity, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { ProcessMemory } from "@/lib/proc/types";
import type { StructuredHostKillRef } from "@/lib/resources";
import { RESOURCE_STRUCTURED_HOST_LIMIT } from "@/lib/types";

import { durableRuntimeEventTailSeq } from "./eventStore";
import type { HandoffRow } from "./handoffQueue";
import { handoffQueue } from "./handoffQueueStore";
import { hasStructuredDeliveryHost, structuredDeliveryHostForConversation } from "./structuredDeliveryController";
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
 * Retirements attempted per sweep. The controller ticks every 60 s and each
 * termination may wait out the grace ladder, so an unbounded batch would let
 * one sweep overrun the next. Everything skipped is reported as deferred and
 * picked up by the following tick.
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
  realtimeBound: boolean;
  /** Null when the registry cannot establish whether this host holds a seat. */
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
 * `seat-free` runs first because it is the clause a missing conversation record
 * fails: without one, neither the seat nor the turn can be established, and an
 * unestablished seat is excluded rather than assumed free — the mistake #1199's
 * review already caught once.
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

  if (subject.activeFlags.length > 0) {
    return refuse("no-active-flags", `the host carries ${subject.activeFlags.length} active flag(s)`);
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

  /* The fence #1203 built needs a kernel identity to bind the kill to. The
     record's own is authoritative; a record that stored none must not inherit
     a null that would disable the recycled-pid check, so the identity observed
     with the pid now stands in for it. */
  const startIdentity = subject.process.startIdentity ?? subject.observedStartIdentity;
  if (subject.observedStartIdentity === null || startIdentity === null) {
    return refuse("process-identity", `no kernel identity can be observed for pid ${subject.process.pid}`);
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
  retired: StructuredHostRetirementRecord[];
  refused: StructuredHostRetirementRefusal[];
  failed: StructuredHostRetirementFailure[];
  reclaimed: StructuredHostRetirementReclaim;
}

export interface StructuredHostRetirementDependencies {
  snapshot?: () => RegistryFile;
  handoffRows?: () => readonly HandoffRow[];
  durableEventTail?: (sessionId: string) => number | null;
  realtimeBound?: (conversationId: string) => boolean;
  orchestratorSeatConversations?: () => ReadonlySet<string>;
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
  const value = Number(env.LLV_HOST_RETIREMENT_GRACE_MS);
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

/** Conversations a live voice call or a hosted realtime thread is bound to.
    Both are process-scoped, because both describe a transport that does not
    survive the Viewer. */
function defaultRealtimeBound(conversationId: string): boolean {
  if (realtimeBoundConversationIds().has(conversationId)) return true;
  try {
    const host = structuredDeliveryHostForConversation(conversationId) as
      { currentRealtimeSessionId?: () => string | null } | null;
    return typeof host?.currentRealtimeSessionId === "function"
      ? host.currentRealtimeSessionId() !== null
      : false;
  } catch {
    /* A host that cannot answer holds no realtime session we can prove; the
       predicate's other clauses still have to pass for it to be retired. */
    return false;
  }
}

function defaultOrchestratorSeatConversations(): ReadonlySet<string> {
  const seats = new Set<string>();
  try {
    for (const seat of activeOrchestratorSeats()) {
      if (seat.conversationId) seats.add(seat.conversationId);
    }
  } catch {
    /* Unreadable seat evidence must not read as "no seats": the registry
       memberships still answer, and a conversation with neither stays unknown
       and therefore excluded. */
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
 */
function undeliveredHandoffIndex(rows: readonly HandoffRow[], file: RegistryFile): RetirementWorkIndex {
  const index = new RetirementWorkIndex();
  for (const row of rows) {
    if (row.status === "terminal" || row.status === "failed") {
      const replayed = new Set(row.replayedDeliveryIds ?? []);
      if (!(row.pendingDeliveries ?? []).some((delivery) => !replayed.has(delivery.deliveryId))) continue;
    }
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
 * One pass over every structured host the registry records.
 *
 * Only recorded hosts are candidates. A process the scan finds with no registry
 * row behind it has no conversation, no cursor and no queue to check, so the
 * predicate cannot be applied to it at all — and a sweep that killed what it
 * could not evaluate would be the failure mode this exists to prevent. The
 * runtime container, its supervisors and the Viewer's own chain are never
 * recorded as structured hosts, and {@link terminateStructuredHostTree} refuses
 * the Viewer's own ancestry a second time.
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
  const file = (dependencies.snapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  const rows = (dependencies.handoffRows ?? (() => {
    try { return handoffQueue().rows(); } catch { return []; }
  }))();
  const undelivered = undeliveredHandoffIndex(rows, file);
  const openOperations = openOperationIndex(file);
  const eventTail = dependencies.durableEventTail ?? ((sessionId: string) => durableRuntimeEventTailSeq(sessionId));
  const realtimeBound = dependencies.realtimeBound ?? defaultRealtimeBound;
  const seatConversations = (dependencies.orchestratorSeatConversations ?? defaultOrchestratorSeatConversations)();
  const stat = dependencies.transcriptStat ?? transcriptStat;
  const identityOf = dependencies.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const memoryOf = dependencies.processMemory ?? ((pids: Iterable<number>) => procBackend.processMemory(pids));
  const ppids = dependencies.ppidMap ?? (() => procBackend.ppidMap());
  const owned = dependencies.owned ?? hasStructuredDeliveryHost;
  const terminate = dependencies.terminate ?? ((ref: StructuredHostKillRef) => terminateStructuredHostTree(ref, {
    graceMs,
    deadlineMs: graceMs + TERMINATION_DEADLINE_MARGIN_MS,
  }));
  const record = dependencies.record ?? recordRetirementReport;

  const conversationsBySession = new Map<string, RegistryFile["conversations"][string]>();
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) conversationsBySession.set(generation.id, conversation);
  }

  const candidates = Object.values(file.entries)
    .filter((entry) => Boolean(entry.structuredHost?.process)
      && (entry.key.engine === "claude" || entry.key.engine === "codex")
      /* A pane-hosted entry belongs to the tmux lifecycle, not to this one. */
      && entry.host === null)
    .slice(0, RESOURCE_STRUCTURED_HOST_LIMIT);

  const report: StructuredHostRetirementReport = {
    version: 1,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: "",
    idleHours: idleMs / 3_600_000,
    evaluated: candidates.length,
    deferred: 0,
    retired: [],
    refused: [],
    failed: [],
    reclaimed: { rssBytes: 0, swapBytes: 0, processes: 0 },
  };

  let parents: Map<number, number> | null = null;
  for (const entry of candidates) {
    const columns = entry.structuredHost!;
    const hostProcess = columns.process!;
    const key = entry.key as SessionKey & { engine: "claude" | "codex" };
    const keyId = sessionKeyId(key);
    const conversation = conversationsBySession.get(key.sessionId) ?? null;
    const conversationId = conversation?.id ?? null;
    const memberships = conversation ? file.memberships[conversation.id] ?? [] : [];
    const pipeline = memberships.find((membership) => membership.kind === "pipeline") ?? null;
    const generation = conversation?.generations.find((candidate) => candidate.id === key.sessionId) ?? null;

    const subject: StructuredHostRetirementSubject = {
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
      undeliveredHandoffEntries: undelivered.count(keyId, conversationId),
      openOperations: openOperations.count(keyId, conversationId),
      eventCursor: columns.eventCursor,
      durableEventTail: eventTail(key.sessionId),
      realtimeBound: conversationId === null ? false : realtimeBound(conversationId),
      seat: conversation === null
        ? null
        : memberships.some((membership) => membership.kind === "orchestrator")
          || seatConversations.has(conversation.id),
      transcriptMtimeMs: entry.artifactPath ? stat(entry.artifactPath)?.mtimeMs ?? null : null,
      observedStartIdentity: identityOf(hostProcess.pid),
    };

    const verdict = structuredHostRetirementVerdict(subject, { now: startedAtMs, idleMs });
    if (!verdict.retire) {
      report.refused.push({ key: keyId, conversationId, clause: verdict.clause, reason: verdict.reason });
      continue;
    }
    if (report.retired.length + report.failed.length >= batch) {
      report.deferred += 1;
      continue;
    }

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
      engine: key.engine,
      sessionId: key.sessionId,
      conversationId,
      seat: subject.seat,
      turnBusy: subject.turnBusy,
      owned: owned(key),
      lastActiveAt: subject.transcriptMtimeMs === null ? null : new Date(subject.transcriptMtimeMs).toISOString(),
    };

    let outcome: StructuredHostTerminationOutcome;
    try {
      outcome = await terminate(ref);
    } catch (error) {
      report.failed.push({ key: keyId, conversationId, error: String(error), remaining: [] });
      continue;
    }
    if (!outcome.ok) {
      /* Either the host is retired and its descendants are collected, or the
         attempt is abandoned and the host left intact. The ladder keeps the
         registry row for anything it could not finish, so nothing here is
         half-retired. */
      report.failed.push({ key: keyId, conversationId, error: outcome.error, remaining: outcome.remaining });
      continue;
    }
    report.retired.push({
      key: keyId,
      engine: key.engine,
      sessionId: key.sessionId,
      conversationId,
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
 * The seam the account-migration controller ticks once a minute — the only
 * thing in the Viewer that runs on its own without an operator gesture.
 *
 * It is deliberately the whole policy: whether the sweep is enabled at all, and
 * that a failing sweep never blocks the rest of the reconciliation cycle. The
 * controller's call site is one line so the two cannot drift.
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
