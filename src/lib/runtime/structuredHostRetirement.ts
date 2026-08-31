import fs from "node:fs";
import path from "node:path";

import { agentRegistry, type AgentHostStatus, type ProcessIdentity, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { activeOrchestratorSeatsOrUnknown, revokedOrchestratorSeatConversationsOrUnknown } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import type { ProcessMemory } from "@/lib/proc/types";
import { processIdentityStatus, systemBootEpoch, type ProcessIdentityProbe } from "@/lib/processIdentity";
import type { StructuredHostKillRef } from "@/lib/resources";
import { RESOURCE_STRUCTURED_HOST_LIMIT } from "@/lib/types";

import { determined, mapDeterminable, undetermined, type Determinable } from "./determinable";
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
 * Four properties are load-bearing and easy to lose:
 *
 * - **An input that cannot be determined refuses, in one place.** Every source
 *   that can fail to answer returns a {@link Determinable}, so no clause ever
 *   sees a bare `null` it has to interpret, and
 *   {@link structuredHostRetirementVerdict} is the single site that turns an
 *   undetermined input into a decision. That decision is always the same one:
 *   the host is not retired, and the report names the clause that could not be
 *   determined. Three review rounds each found a different clause that had
 *   invented its own fallback and happened to resolve unknown in favour of
 *   killing; a fallback is now a thing a clause cannot express.
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
 * How often the release that owns traffic sweeps.
 *
 * Far slower than the reconciliation controllers, and deliberately so: the
 * default quiet interval is six hours, so a few minutes of latency costs
 * nothing, while every tick reads `/proc` for each recorded host inside the
 * process that is also serving the operator's board.
 */
export const STRUCTURED_HOST_RETIREMENT_INTERVAL_MS = 5 * 60_000;

/** Retirements attempted per sweep, whatever the grace allows. Past this a
    sweep is doing enough at once that the next one can finish the job. */
const RETIREMENT_BATCH_CEILING = 8;
/** The share of one interval a sweep may spend inside termination ladders. The
    rest pays for the registry, `/proc` and transcript reads around them, and
    leaves the tick after it a clear start. */
const RETIREMENT_TERMINATION_BUDGET_RATIO = 0.5;

/**
 * How many retirements one sweep attempts, sized against the grace it will
 * actually run with.
 *
 * Each termination waits out its own ladder — the graceful window plus the
 * deadline margin — so a fixed batch only bounds a sweep for the grace it was
 * chosen against. At the 60 s maximum an eight-host batch is ~9 minutes of
 * ladders against a 5-minute tick, which is the overrun the bound exists to
 * prevent. Everything skipped is reported as deferred and picked up by the
 * following sweep; nothing is lost, it only takes another interval.
 */
export function structuredHostRetirementBatch(
  graceMs: number,
  intervalMs: number = STRUCTURED_HOST_RETIREMENT_INTERVAL_MS,
): number {
  const perHostMs = Math.max(1, graceMs + TERMINATION_DEADLINE_MARGIN_MS);
  const budgetMs = intervalMs * RETIREMENT_TERMINATION_BUDGET_RATIO;
  /* One is the floor: a single ladder can outlast any budget, and a sweep that
     retires nothing at all would leak hosts forever to protect a schedule. */
  return Math.max(1, Math.min(RETIREMENT_BATCH_CEILING, Math.floor(budgetMs / perHostMs)));
}

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

/**
 * Where one host stands with the orchestrator seat — the third answer #1245
 * needed and a boolean could not carry.
 *
 * Rotation is authority-only: `executeOrchestratorRotation` records a
 * revocation and leaves the predecessor's session, host and Viewer access
 * exactly as they were, while the registry membership row that says
 * "orchestrator" is epoch-stamped and never removed. So a rotated-away seat
 * read as `live` here forever, and `seat-free` — the very first clause —
 * refused it forever. It then defeated `transcript-idle` too, by the activity
 * that should have disqualified it: a seat that schedules itself writes its
 * transcript every few minutes and is never idle. Both readings came from the
 * same missing distinction, which is why one field carries it rather than two.
 *
 * - `none` — no seat evidence at all, the ordinary host.
 * - `live` — a seat somebody is still seated in. Blocks retirement outright.
 * - `revoked` — a seat whose authority the durable store has ended. It is not
 *   a live seat, and its recency is not evidence of anything worth keeping.
 */
export type StructuredHostSeatStanding = "none" | "live" | "revoked";

/**
 * Everything the predicate reads about one host, gathered before any of it is
 * judged, so the audit can report the facts alongside the verdict.
 *
 * Every field a source might fail to answer is a {@link Determinable}, and it
 * is the reader that says so, at the point it failed, with the reason. A field
 * that is a plain value comes out of the registry snapshot the sweep already
 * holds and cannot be unknown; a determined `null` inside one is a real,
 * established absence, which is the distinction an overloaded `| null` lost.
 */
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
  /** Undetermined when no conversation record establishes a turn state. */
  turnBusy: Determinable<boolean>;
  pendingAttention: readonly string[];
  activeFlags: readonly string[];
  pendingAction: string | null;
  structuredHostOperationId: string | null;
  /** Undetermined when the handoff queue could not be read: an unreadable
      queue is not a drained one. */
  undeliveredHandoffEntries: Determinable<number>;
  openOperations: number;
  /** The registry's persisted cursor: the flushed one. */
  eventCursor: number;
  /** The ledger's durable tail: the session's own cursor. Undetermined when the
      ledger exists but could not be read to its last complete record. */
  durableEventTail: Determinable<number>;
  /** Undetermined when this process cannot establish whether a live transport
      is bound — a state the sweep refuses on rather than reads as "no call". */
  realtimeBound: Determinable<boolean>;
  /** Undetermined when neither the registry nor the durable seat store
      establishes where this host stands with the seat. */
  seat: Determinable<StructuredHostSeatStanding>;
  /** The transcript's modification time, a determined `null` when the host
      names none or it is genuinely gone, and undetermined when the path could
      not be read at all. */
  transcriptFile: Determinable<{ mtimeMs: number } | null>;
  /** Undetermined when the kernel will not say what is on the pid now. */
  observedStartIdentity: Determinable<string>;
  /** Undetermined when the kernel will not identify the current boot. */
  observedBootEpoch: Determinable<string>;
}

export type StructuredHostRetirementVerdict =
  | { retire: true; passed: StructuredHostRetirementClause[]; startIdentity: string }
  | {
      retire: false;
      clause: StructuredHostRetirementClause;
      reason: string;
      /** Set when the clause refused because it could not establish its input,
          as opposed to establishing one that blocks. */
      undetermined?: true;
    };

/**
 * What one clause says about one subject: a determined `null` passes, a
 * determined string is the reason it refuses, and an undetermined answer is a
 * clause that could not read its own input. No clause decides what the third
 * case means — {@link structuredHostRetirementVerdict} does, once, for all of
 * them.
 */
type ClauseAnswer = Determinable<string | null>;

const PASSES: ClauseAnswer = determined(null);
const refuses = (reason: string): ClauseAnswer => determined(reason);

/** Whether the durable seat store has ENDED this host's authority. Undetermined
    is never revoked: `seat-free` has already refused on it by the time any
    later clause asks, and a waiver granted on an unread store would be exactly
    the invented fallback this predicate refuses to let a clause express. */
function seatWasRevoked(subject: StructuredHostRetirementSubject): boolean {
  return subject.seat.determined && subject.seat.value === "revoked";
}

/** The identity the kill is fenced to, or the reason there is none to fence to.
 *
 * The fence #1203 built binds a kill to the identity the record stored, and
 * only to that. A stored null is not a gap to fill: the hosts write it
 * precisely when they concluded their own pid was recycled or unverifiable, so
 * substituting today's observation would compare an observation against itself
 * and hand an unattended sweep a tree it never identified. Refusing costs one
 * leaked host; substituting can cost an unrelated process tree.
 */
function recordedStartIdentity(subject: StructuredHostRetirementSubject): Determinable<string> {
  return subject.process.startIdentity === null
    ? undetermined(`the registry stored no kernel identity for pid ${subject.process.pid}`)
    : determined(subject.process.startIdentity);
}

function recordedBootEpoch(subject: StructuredHostRetirementSubject): Determinable<string> {
  return typeof subject.process.bootEpoch === "string" && subject.process.bootEpoch
    ? determined(subject.process.bootEpoch)
    : undetermined(`the registry stored no boot epoch for pid ${subject.process.pid}`);
}

/**
 * The clauses, each a function of the subject alone. Order comes from
 * {@link STRUCTURED_HOST_RETIREMENT_CLAUSES}, so the list and the checks cannot
 * disagree about what the predicate is.
 *
 * `seat-free` runs first because it is the clause an unestablished fact fails
 * first: with no conversation record neither the seat nor the turn can be
 * established, and with no readable seat store the live authority itself is
 * silent. An unestablished seat is excluded rather than assumed free — the
 * mistake #1199's review already caught once, and an orchestrator is exactly
 * the host that sits quiet for hours between operator messages, so it would
 * pass every other clause.
 *
 * THE REVOKED-SEAT RULE (#1245) is one rule read in two of these clauses,
 * because a revocation says two things at once and both have to land or
 * neither is worth saying. `seat-free` stops calling a revoked seat live: the
 * epoch-stamped membership row a rotation leaves behind is a record of the
 * seat that ended, not evidence of one somebody holds. `transcript-idle` waives
 * its threshold for the same host: what that clause measures is whether
 * anything would be lost by stopping, and a seat whose authority has been
 * revoked can lose nothing it is still entitled to do — the observed failure
 * was a predecessor whose own self-scheduled monitor kept its transcript warm
 * and so kept it permanently ineligible for the sweep that should have ended
 * it. Every other clause still applies unchanged, so the predecessor's turn
 * still has to settle, its questions still have to be answered and its queue
 * still has to drain: the rule removes a seat's protection, never a turn's.
 */
const CLAUSE_CHECKS: Record<
  StructuredHostRetirementClause,
  (subject: StructuredHostRetirementSubject, options: { now: number; idleMs: number }) => ClauseAnswer
> = {
  "seat-free": (subject) => mapDeterminable(subject.seat,
    (standing) => (standing === "live" ? "the host holds a live orchestrator seat" : null)),

  "turn-settled": (subject) => {
    if (subject.activeTurnRef !== null) return refuses(`turn ${subject.activeTurnRef} is in flight`);
    return mapDeterminable(subject.turnBusy, (busy) => (busy ? "the conversation turn has not settled" : null));
  },

  "attention-settled": (subject) => (subject.pendingAttention.length > 0
    ? refuses(`${subject.pendingAttention.length} question(s) await an operator answer`)
    : PASSES),

  "host-idle-or-dead": (subject) => (RETIRABLE_HOST_STATUSES.has(subject.status)
    ? PASSES
    : refuses(`the host status is ${subject.status}`)),

  /* Capability advertisements are not activity: every Claude host carries
     `structured-image-v1` (and the multi-agent denial's tool set) for its whole
     life, so reading the raw array refuses every Claude host forever and
     retires nothing at all. Anything the classifier does not recognise still
     counts as activity and still refuses. */
  "no-active-flags": (subject) => {
    const activityFlags = blockingHostActivityFlags(subject.activeFlags);
    return activityFlags.length > 0 ? refuses(`the host is flagged ${activityFlags.join(", ")}`) : PASSES;
  },

  "handoff-queue-drained": (subject) => mapDeterminable(subject.undeliveredHandoffEntries,
    (count) => (count > 0 ? `${count} undelivered handoff entr(ies) name this key` : null)),

  "no-open-operation": (subject) => {
    if (subject.pendingAction !== null) return refuses(`a ${subject.pendingAction} action is pending`);
    if (subject.structuredHostOperationId !== null) return refuses("a structured host operation is still in flight");
    return subject.openOperations > 0
      ? refuses(`${subject.openOperations} spawn receipt(s) are pending or non-terminal`)
      : PASSES;
  },

  "events-flushed": (subject) => mapDeterminable(subject.durableEventTail,
    (tail) => (subject.eventCursor < tail
      ? `the flushed cursor ${subject.eventCursor} is behind the session's ${tail}`
      : null)),

  "no-realtime-binding": (subject) => mapDeterminable(subject.realtimeBound,
    (bound) => (bound ? "a realtime session is bound to this conversation" : null)),

  /* Resumability is the whole reason retirement is safe, so it is proven, not
     assumed: the session key IS the resume token, and the transcript it names
     has to be on disk right now. */
  "resumable": (subject) => {
    if (subject.transcriptPath === "") return refuses("the host names no transcript to resume from");
    return mapDeterminable(subject.transcriptFile,
      (stat) => (stat === null ? "the transcript is not present on disk" : null));
  },

  "transcript-idle": (subject, options) => mapDeterminable(subject.transcriptFile, (stat) => {
    /* Order puts `resumable` first, so an absent transcript has already
       refused; saying it again here keeps the clause true on its own terms
       rather than relying on the clause before it. */
    if (stat === null) return "the transcript is not present on disk";
    /* The revoked-seat waiver (#1245). Recency is evidence that a host is
       doing something, and this is the one host whose doing something is the
       problem: rotation ends its authority and nothing else, so it kept
       ticking, kept writing, and kept clearing this threshold's floor by the
       activity that disqualified it. The waiver is narrow on purpose — it is
       read off a determined revocation and nothing weaker, and every clause
       that protects work in flight still had to pass to get here. */
    if (seatWasRevoked(subject)) return null;
    const idleMs = options.now - stat.mtimeMs;
    return idleMs < options.idleMs
      ? `the transcript was written ${Math.max(0, Math.round(idleMs / 1_000))}s ago`
      : null;
  }),

  "process-identity": (subject) => {
    const recordedStart = recordedStartIdentity(subject);
    if (!recordedStart.determined) return recordedStart;
    const recordedBoot = recordedBootEpoch(subject);
    if (!recordedBoot.determined) return recordedBoot;
    if (!subject.observedStartIdentity.determined) return subject.observedStartIdentity;
    if (!subject.observedBootEpoch.determined) return subject.observedBootEpoch;
    const observedStartIdentity = subject.observedStartIdentity.value;
    const observedBootEpoch = subject.observedBootEpoch.value;
    const probe: ProcessIdentityProbe = {
      pidAlive: () => true,
      processIdentity: () => observedStartIdentity,
      bootEpoch: () => observedBootEpoch,
    };
    return processIdentityStatus(subject.process, probe) === "alive"
      ? PASSES
      : refuses(`pid ${subject.process.pid} is no longer the recorded host`);
  },
};

/**
 * The conjunction, and the one place an undetermined input becomes a decision.
 *
 * Clause order is check order, and the first refusal is the reported one, so a
 * subject that fails several still names a single cause the operator can act
 * on. A clause that could not establish its input refuses exactly like one that
 * established a blocking answer, and says which of the two it was: an
 * unestablished fact is not an idle one, and no clause gets to decide that for
 * itself.
 */
export function structuredHostRetirementVerdict(
  subject: StructuredHostRetirementSubject,
  options: { now: number; idleMs: number },
): StructuredHostRetirementVerdict {
  const passed: StructuredHostRetirementClause[] = [];
  for (const clause of STRUCTURED_HOST_RETIREMENT_CLAUSES) {
    const answer = CLAUSE_CHECKS[clause](subject, options);
    if (!answer.determined) return { retire: false, clause, reason: answer.why, undetermined: true };
    if (answer.value !== null) return { retire: false, clause, reason: answer.value };
    passed.push(clause);
  }
  /* Re-resolved rather than carried out of the loop: the same reader the
     `process-identity` clause used, so the identity the kill is fenced to is
     the identity the clause passed on. */
  const startIdentity = recordedStartIdentity(subject);
  if (!startIdentity.determined) {
    return { retire: false, clause: "process-identity", reason: startIdentity.why, undetermined: true };
  }
  return { retire: true, passed, startIdentity: startIdentity.value };
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
  /** Set when the revoked-seat rule (#1245) is what let this host through, so
      a retirement seconds after a rotation is legible as the rotation
      finishing rather than as the idle threshold having been ignored. */
  seatRevoked?: true;
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
  /** Set when the clause refused because its input could not be established.
      This is the audit's answer to "which clause could not be determined", and
      it is why an undetermined input is loud rather than silent: the host is
      kept, and the reason it was kept is the reader that failed. */
  undetermined?: true;
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

/**
 * The sweep's reads, every one of them injectable.
 *
 * Each reader that can fail to answer returns a {@link Determinable}: the
 * "unknown" shape is the seam's own contract, not something the sweep infers
 * from a null at the far end of it. A reader that cannot fail returns a plain
 * value, and that difference is the type telling the truth about the source.
 *
 * The sources behind these — `/proc`, the handoff queue, the seat store, the
 * event ledger, `stat` — each keep their own idiom for "I could not answer".
 * Each is translated exactly once, in the default reader below, and never
 * again: past this boundary there is one way to say unknown and one place that
 * decides what it means.
 */
export interface StructuredHostRetirementDependencies {
  publicationState?: () => "ready" | "rebinding" | "unbound";
  snapshot?: () => RegistryFile;
  /** Undetermined when the queue could not be read: silence is not a drained
      queue, and reading it as one strands the message it still holds. */
  handoffRows?: () => Determinable<readonly HandoffRow[]>;
  durableEventTail?: (sessionId: string) => Determinable<number>;
  realtimeBound?: (conversationId: string) => Determinable<boolean>;
  /** Undetermined when the durable seat store could not be established — the
      sweep refuses rather than reading silence as "no seats". */
  orchestratorSeatConversations?: () => Determinable<ReadonlySet<string>>;
  /** The other half of the same store: seats whose authority has been revoked
      (#1245). Undetermined on the same terms, and for the same reason. */
  revokedSeatConversations?: () => Determinable<ReadonlySet<string>>;
  /** A determined `null` is a transcript that is genuinely not there; an
      unreadable path is undetermined. */
  transcriptStat?: (pathname: string) => Determinable<{ mtimeMs: number } | null>;
  processIdentity?: (pid: number) => Determinable<string>;
  bootEpoch?: () => Determinable<string>;
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

/**
 * The transcript the resume would read, or the reason its state is unknown.
 *
 * A transcript that is genuinely gone is an established fact and refuses at
 * `resumable`; a path that could not be read — a permission error, an
 * unreachable mount — is not the same fact, and collapsing the two would let a
 * transient read error present as "this conversation has no history left".
 */
function transcriptStat(pathname: string): Determinable<{ mtimeMs: number } | null> {
  try {
    const stats = fs.statSync(pathname);
    return determined(stats.isFile() ? { mtimeMs: stats.mtimeMs } : null);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? determined(null)
      : undetermined(`the transcript could not be read (${code ?? "unknown"})`);
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
function defaultRealtimeBound(conversationId: string): Determinable<boolean> {
  try {
    if (realtimeBoundConversationIds().has(conversationId)) return determined(true);
    const host = structuredDeliveryHostForConversation(conversationId) as
      { currentRealtimeSessionId?: () => string | null } | null;
    return determined(typeof host?.currentRealtimeSessionId === "function"
      ? host.currentRealtimeSessionId() !== null
      : false);
  } catch (error) {
    return undetermined(`the realtime binding could not be read: ${safeReason(error)}`);
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
function defaultOrchestratorSeatConversations(): Determinable<ReadonlySet<string>> {
  let seats: Set<string>;
  try {
    const active = activeOrchestratorSeatsOrUnknown();
    if (active === null) return undetermined("the orchestrator seat store could not be established");
    const resolveAlias = registryConversationAlias();
    seats = new Set(active.flatMap((seat) => (seat.conversationId ? [resolveAlias(seat.conversationId)] : [])));
  } catch (error) {
    return undetermined(`the orchestrator seat store could not be read: ${safeReason(error)}`);
  }
  return determined(seats);
}

/**
 * A raw conversation id mapped onto the identity the registry canonicalized it
 * to, for the two durable seat reads either side of it.
 *
 * Both are joined against `conversation.id` from the registry snapshot, which
 * IS canonical; the seat file keeps whatever id each row was written with. A
 * migration between the two is enough to make a revoked seat read as live —
 * the sweep would then refuse it forever, which is the exact failure #1245
 * exists to end — so the join resolves through the same aliasing the authority
 * resolver takes from its sources.
 */
function registryConversationAlias(): (conversationId: string) => string {
  const registry = agentRegistry();
  return (conversationId) => registry.canonicalConversationId(conversationId as `conversation_${string}`);
}

/**
 * Conversations whose seat authority the durable store has ended, or null when
 * that store could not be established.
 *
 * Read separately from the live seats above, and unknown here refuses exactly
 * as unknown there does: the two answers combine in {@link seatStanding}, and a
 * silence read as "revoked by nobody" would keep a rotated-away orchestrator
 * alive, while a silence read as "revoked" would retire a seated one. Neither
 * is a guess this may make, so it does not.
 */
function defaultRevokedSeatConversations(): Determinable<ReadonlySet<string>> {
  let revoked: ReturnType<typeof revokedOrchestratorSeatConversationsOrUnknown>;
  try {
    revoked = revokedOrchestratorSeatConversationsOrUnknown(registryConversationAlias());
  } catch (error) {
    return undetermined(`the orchestrator revocation record could not be read: ${safeReason(error)}`);
  }
  return revoked === null
    ? undetermined("the orchestrator revocation record could not be established")
    : determined(revoked);
}

/** An error reduced to something an audit line can carry. */
function safeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 *
 * Clauses that could not be DETERMINED are counted separately, because the two
 * mean opposite things about the machine: a refusal is the predicate working,
 * an undetermined clause is a reader that stopped answering, and a ledger,
 * queue or seat store that has gone quiet would otherwise hide inside a
 * refusal count that looks entirely healthy.
 */
export function structuredHostRetirementJournalRecord(
  report: StructuredHostRetirementReport,
): Omit<StructuredHostRetirementReport, "refused"> & {
  refusedByClause: Record<string, number>;
  undeterminedByClause: Record<string, number>;
} {
  const { refused, ...rest } = report;
  const refusedByClause: Record<string, number> = {};
  const undeterminedByClause: Record<string, number> = {};
  for (const item of refused) {
    refusedByClause[item.clause] = (refusedByClause[item.clause] ?? 0) + 1;
    if (item.undetermined) undeterminedByClause[item.clause] = (undeterminedByClause[item.clause] ?? 0) + 1;
  }
  return { ...rest, refusedByClause, undeterminedByClause };
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
    const why = retired.seatRevoked ? ", revoked seat" : "";
    console.warn(`[host retirement] retired ${retired.key} (${retired.role ?? "no role"}, idle ${Math.round(retired.idleMs / 60_000)}m${why}) via ${retired.via}: ${retired.reclaimed.processes} process(es), ${Math.round(retired.reclaimed.rssBytes / 1_048_576)} MiB resident + ${Math.round(retired.reclaimed.swapBytes / 1_048_576)} MiB swapped reclaimed`);
  }
  for (const failure of report.failed) {
    console.warn(`[host retirement] left ${failure.key} intact: ${failure.error}`);
  }
  /* One aggregated line, not one per host: a broken seat store or ledger makes
     every candidate undetermined at once, and the operator needs the clause
     named, not the population enumerated once every five minutes. */
  const clauses = Object.entries(structuredHostRetirementJournalRecord(report).undeterminedByClause);
  if (clauses.length > 0) {
    const named = clauses.map(([clause, count]) => `${clause} (${count})`).join(", ");
    const example = report.refused.find((item) => item.undetermined)?.reason ?? "";
    console.warn(`[host retirement] kept hosts whose clauses could not be determined: ${named} — ${example}`);
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
function undeliveredHandoffIndex(
  rows: Determinable<readonly HandoffRow[]>,
  file: RegistryFile,
): Determinable<RetirementWorkIndex> {
  /* A queue that could not be read is not a drained one. The registry's held
     deliveries would still be readable here, and counting only those would
     produce a confident zero for a key whose queued message is sitting in the
     source that failed. */
  return mapDeterminable(rows, (readable) => {
    const index = new RetirementWorkIndex();
    for (const row of readable) {
      const replayed = new Set(row.replayedDeliveryIds ?? []);
      if (!(row.pendingDeliveries ?? []).some((delivery) => !replayed.has(delivery.deliveryId))) continue;
      if (row.engine === "claude" || row.engine === "codex") index.addKey(`${row.engine}:${row.engineSessionId}`);
      else index.addConversation(row.conversationId);
    }
    for (const delivery of Object.values(file.heldDeliveries ?? {})) {
      if (UNDELIVERED_HELD_STATES.has(delivery.state)) index.addConversation(delivery.conversationId);
    }
    return index;
  });
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
  undelivered: Determinable<RetirementWorkIndex>;
  openOperations: RetirementWorkIndex;
  /** The seat file is one read per pass, not one per host: a candidate list is
      bounded but not small, and this is a file. Undetermined when it could not
      be read at all, which is a refusal rather than an empty set. */
  seatConversations: Determinable<ReadonlySet<string>>;
  /** Revoked seats, on the same terms and from the same pass. */
  revokedConversations: Determinable<ReadonlySet<string>>;
}

/** Per-host facts that come from a durable read the whole pass shares. */
interface RetirementSources {
  snapshot: () => RegistryFile;
  handoffRows: () => Determinable<readonly HandoffRow[]>;
  seatConversations: () => Determinable<ReadonlySet<string>>;
  revokedConversations: () => Determinable<ReadonlySet<string>>;
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
    revokedConversations: sources.revokedConversations(),
  };
}

/** The live facts the predicate reads off the machine rather than out of a
    durable store. Every one is re-read on the re-check, because every one of
    them can change under it. */
interface RetirementReaders {
  durableEventTail: (sessionId: string) => Determinable<number>;
  realtimeBound: (conversationId: string) => Determinable<boolean>;
  transcriptStat: (pathname: string) => Determinable<{ mtimeMs: number } | null>;
  processIdentity: (pid: number) => Determinable<string>;
  bootEpoch: () => Determinable<string>;
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
 * Where this conversation stands with the orchestrator seat, or unknown when
 * that cannot be established.
 *
 * A registry orchestrator membership is durable evidence that a seat was HELD.
 * The seat store is the live authority on whether it still is, so when it
 * cannot be read a conversation with no membership row is unknown — never free.
 *
 * The revocation record is asked only of a conversation that has seat evidence
 * at all, and that ordering is the whole point: nothing can revoke a seat an
 * ordinary host never held, so an unreadable revocation record costs those
 * hosts nothing, and the one host it can decide is the one whose answer
 * matters.
 *
 * `conversationId` is the registry's canonical id, and both sets are keyed the
 * same way (see {@link registryConversationAlias}) — a raw seat-file id on
 * either side would miss the join for a migrated identity.
 */
function seatStanding(
  conversationId: string,
  memberships: readonly { kind: string }[],
  seatConversations: Determinable<ReadonlySet<string>>,
  revokedConversations: Determinable<ReadonlySet<string>>,
): Determinable<StructuredHostSeatStanding> {
  const held: Determinable<boolean> = memberships.some((membership) => membership.kind === "orchestrator")
    ? determined(true)
    : mapDeterminable(seatConversations, (seats) => seats.has(conversationId));
  if (!held.determined) return held;
  if (!held.value) return determined("none");
  return mapDeterminable(revokedConversations,
    (revoked) => (revoked.has(conversationId) ? "revoked" : "live"));
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
    turnBusy: conversation === null
      ? undetermined("no conversation record establishes this host's turn state")
      : conversation.turn.state === "unknown"
        ? undetermined("the conversation's turn state is unknown")
        : determined(conversation.turn.state === "busy"),
    pendingAttention: columns.pendingAttention,
    activeFlags: columns.activeFlags,
    pendingAction: entry.pendingAction,
    structuredHostOperationId: entry.structuredHostOperationId ?? null,
    undeliveredHandoffEntries: mapDeterminable(inputs.undelivered,
      (index) => index.count(keyId, conversationId)),
    openOperations: inputs.openOperations.count(keyId, conversationId),
    eventCursor: columns.eventCursor,
    durableEventTail: readers.durableEventTail(key.sessionId),
    realtimeBound: conversationId === null
      ? undetermined("the host names no conversation, so no realtime binding can be looked up")
      : readers.realtimeBound(conversationId),
    seat: conversation === null
      ? undetermined("no conversation record establishes whether this host holds a seat")
      : seatStanding(conversation.id, memberships, inputs.seatConversations, inputs.revokedConversations),
    transcriptFile: entry.artifactPath
      ? readers.transcriptStat(entry.artifactPath)
      : determined(null),
    observedStartIdentity: readers.processIdentity(hostProcess.pid),
    observedBootEpoch: readers.bootEpoch(),
  };
}

/**
 * Hands a fact to the interactive kill gate in the shape that gate speaks.
 *
 * `structuredHostKillRefusal` has its own "unknown", a null, and it refuses on
 * one exactly as this predicate does — so an undetermined fact crossing as null
 * is fail-closed on the far side too. Both of these are determined by the time
 * a subject qualifies; this keeps the conversion total without a cast.
 */
function killRefFact<T>(input: Determinable<T>): T | null {
  return input.determined ? input.value : null;
}

/** The transcript time a qualified subject was measured against. Determined and
    present by construction — every clause has already passed — so the fallback
    is a type narrowing rather than a decision. */
function qualifiedTranscriptMtimeMs(subject: StructuredHostRetirementSubject): number | null {
  return subject.transcriptFile.determined ? subject.transcriptFile.value?.mtimeMs ?? null : null;
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
  const batch = dependencies.batch ?? structuredHostRetirementBatch(graceMs);
  const snapshot = dependencies.snapshot ?? (() => agentRegistry().readOnlySnapshot());
  const handoffRows = dependencies.handoffRows ?? (() => {
    try { return determined(handoffQueue().rows()); }
    catch (error) { return undetermined(`the handoff queue could not be read: ${safeReason(error)}`); }
  });
  const sources: RetirementSources = {
    snapshot,
    handoffRows,
    seatConversations: dependencies.orchestratorSeatConversations ?? defaultOrchestratorSeatConversations,
    revokedConversations: dependencies.revokedSeatConversations ?? defaultRevokedSeatConversations,
  };
  const readers: RetirementReaders = {
    durableEventTail: dependencies.durableEventTail ?? ((sessionId: string) => durableRuntimeEventTailSeq(sessionId)),
    realtimeBound: dependencies.realtimeBound ?? defaultRealtimeBound,
    transcriptStat: dependencies.transcriptStat ?? transcriptStat,
    processIdentity: dependencies.processIdentity ?? ((pid: number) => {
      const identity = procBackend.processIdentity(pid);
      return identity === null
        ? undetermined(`no kernel identity can be observed for pid ${pid}`)
        : determined(identity);
    }),
    bootEpoch: dependencies.bootEpoch ?? (() => {
      const epoch = systemBootEpoch();
      return epoch === null ? undetermined("the kernel boot epoch could not be read") : determined(epoch);
    }),
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
        ...(verdict.undetermined ? { undetermined: true as const } : {}),
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
        ...(verdict.undetermined ? { undetermined: true as const } : {}),
        changed: true,
      });
      continue;
    }
    const hostProcess = subject.process;
    const transcriptMtimeMs = qualifiedTranscriptMtimeMs(subject);

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
      bootEpoch: hostProcess.bootEpoch ?? null,
      engine: subject.key.engine,
      sessionId: subject.key.sessionId,
      conversationId: subject.conversationId,
      /* The gate's question is "is this a LIVE seat", and a revoked one is not:
         the same distinction the predicate just made, handed across in the two
         values that gate speaks. */
      seat: subject.seat.determined ? subject.seat.value === "live" : null,
      turnBusy: killRefFact(subject.turnBusy),
      owned: owned(subject.key),
      lastActiveAt: transcriptMtimeMs === null ? null : new Date(transcriptMtimeMs).toISOString(),
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
      idleMs: transcriptMtimeMs === null ? 0 : startedAtMs - transcriptMtimeMs,
      passed: verdict.passed,
      ...(seatWasRevoked(subject) ? { seatRevoked: true as const } : {}),
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
