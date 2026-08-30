import fs from "node:fs";
import os from "node:os";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { AgentRegistry, ProcessIdentity, RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { recordValue, recordsValue, stringValue } from "@/lib/scanner/json";

/**
 * Whether a turn is being worked on, decided from evidence rather than from a
 * status word (#1281).
 *
 * `live`, `idle` and `busy` are all inherited: a registry row keeps whatever
 * the last writer left there, so a turn severed by a redeploy reads busy
 * forever and a step that legitimately takes ten minutes reads stalled. Both
 * mistakes are live, and both are made by reading the word instead of the
 * facts underneath it. The facts are:
 *
 * - the last transcript event **and its kind** — an unanswered tool call is a
 *   different fact from a settled assistant message;
 * - whether the process the registry believes owns the turn still exists, and
 *   is still that process;
 * - CPU consumed **since that process launched** — a host that has burned
 *   essentially none and written nothing since its own launch never started;
 * - whether a delivery has been outstanding for it, and for how long.
 *
 * The first fact gates the rest: with no readable turn there is nothing for the
 * others to be facts about, so an unreadable tail ends the reading immediately.
 * Past that gate the asymmetry is deliberate — `working` needs one positive
 * sign and is given on any of them; `severed` needs positive evidence of
 * absence and is refused whenever the platform cannot supply it. Everything
 * else answers `unknown`, which every consumer treats as "do not act".
 */

/** What the newest transcript record is. The kind is load-bearing: a turn
    whose last event is a tool result is open and unanswered; one whose last
    event is an assistant message may be settled. */
export type TranscriptEventKind =
  | "assistant-message"
  | "tool-call"
  | "tool-result"
  | "user-message"
  | "other";

export interface TranscriptLivenessEvidence {
  /** Wall clock of the newest record, or null when the tail is unreadable. */
  lastEventAt: number | null;
  kind: TranscriptEventKind | null;
  /** When the artifact was last written, whether or not its tail could be
      parsed. A host appending to a transcript is working even when the newest
      record carries no clock this reader understands. */
  lastWriteAt: number | null;
  /** The turn axis that tail leaves behind. */
  turn: "busy" | "terminal" | "unknown";
}

export interface HostProcessLivenessEvidence {
  /** The process the registry believes owns the turn; null when it names none. */
  expected: ProcessIdentity | null;
  /** Whether that pid exists right now. */
  present: boolean;
  /** The identity the kernel reports for that pid right now, when it can. */
  observedIdentity: string | null;
  /** CPU (user + system) this process has consumed since it launched, in ms.
      Null when the platform cannot report it — never read as zero. */
  cpuMs: number | null;
  /** CPU consumed over a recent observation window whose transcript write clock
      stayed unchanged. This separates one-time resume cost from current work. */
  cpuProgress: { consumedMs: number; observedMs: number } | null;
  /** Wall clock of the process launch, derived from its start-time token. */
  launchedAt: number | null;
}

export interface TurnLivenessEvidence {
  now: number;
  transcriptTail: TranscriptLivenessEvidence;
  host: HostProcessLivenessEvidence;
  /** Since when a delivery has been waiting on this host, when one has. */
  delivery: { outstandingSince: number | null };
}

export type TurnLiveness = "working" | "severed" | "settled" | "unknown";

export interface TurnLivenessDecision {
  state: TurnLiveness;
  /** The evidence that produced the verdict, named. Never a status word. */
  reason: string;
  /** Wall clock from which a `severed` verdict has held, so a caller can hold
      it against a grace period. Stable across repeated reads — never `now`,
      which would restart every grace on every tick. */
  since: number | null;
  /** The turn axis the transcript tail leaves, so a caller that only acts on a
      turn that was actually in flight can say so (#1276). */
  turn: TranscriptLivenessEvidence["turn"];
  /** The last transcript event's kind and clock, for a message or a report
      that has to name the turn it is talking about. */
  lastEvent: { kind: TranscriptEventKind | null; at: number | null };
}

/** A host younger than this has not had time to prove anything: a resume reads
    its transcript and starts its CLI before it writes a byte. */
export const LIVENESS_OBSERVATION_WINDOW_MS = 90_000;

/** Ordinary board polls establish recent CPU progress. The incident was
    measured over 100 seconds; a 60-second floor detects the same flat process
    within that observation while retaining several scheduler samples on the
    normal ten-second cadence. */
export const LIVENESS_CPU_PROGRESS_WINDOW_MS = 60_000;

/** CPU per minute of life above which a host that has written nothing is still
    doing something. The severed specimen in #1281 had burned 4.7 s in 34
    minutes — 138 ms/min — which is what resuming a transcript costs. */
export const LIVENESS_WORKING_CPU_MS_PER_MINUTE = 250;

/** How long a delivery may wait on a host that has written nothing since its
    own launch before the wait is itself the evidence. This is the only route
    to `severed` on a platform with no CPU accounting. */
export const LIVENESS_OUTSTANDING_DELIVERY_MS = 5 * 60_000;

const MILLISECONDS_PER_MINUTE = 60_000;
/** USER_HZ. Fixed at 100 on every Linux this runs on; /proc reports process
    start time and CPU in these ticks. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

function elapsedMinutes(milliseconds: number): number {
  return Math.max(milliseconds, 1) / MILLISECONDS_PER_MINUTE;
}

function when(timestamp: number | null): string {
  return timestamp === null ? "unknown time" : new Date(timestamp).toISOString();
}

function ago(now: number, timestamp: number): string {
  return `${Math.max(0, Math.round((now - timestamp) / 1_000))}s ago`;
}

/**
 * Wall clock of a process launch, read out of the start-time token the proc
 * backend stamps into a process identity.
 *
 * Linux writes `pid:startTicks`, ticks since boot; darwin writes
 * `pid:seconds:microseconds`, an absolute clock. Both are the same token the
 * registry already stores to fence a pid against reuse, so this needs nothing
 * the row does not already carry.
 */
export function processLaunchedAt(
  identity: string | null,
  clock: { now?: () => number; uptimeSeconds?: () => number } = {},
): number | null {
  if (!identity) return null;
  const parts = identity.split(":");
  if (parts.length === 3) {
    const seconds = Number(parts[1]);
    const microseconds = Number(parts[2]);
    if (!Number.isFinite(seconds) || !Number.isFinite(microseconds) || seconds <= 0) return null;
    return Math.round(seconds * 1_000 + microseconds / 1_000);
  }
  if (parts.length !== 2) return null;
  const ticks = Number(parts[1]);
  if (!Number.isFinite(ticks) || ticks < 0) return null;
  const now = (clock.now ?? Date.now)();
  const uptimeSeconds = (clock.uptimeSeconds ?? os.uptime)();
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return null;
  return Math.round(now - uptimeSeconds * 1_000 + (ticks / LINUX_CLOCK_TICKS_PER_SECOND) * 1_000);
}

export interface HostProcessEvidenceDependencies {
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
  processCpuMs?: (pid: number) => number | null;
  now?: () => number;
  uptimeSeconds?: () => number;
  observeCpuProgress?: (input: {
    process: ProcessIdentity;
    observedIdentity: string;
    cpuMs: number;
    transcriptLastWriteAt: number | null;
    now: number;
  }) => HostProcessLivenessEvidence["cpuProgress"];
}

/** Everything the kernel can say about the process a registry row claims. */
export function readHostProcessEvidence(
  expected: ProcessIdentity | null,
  dependencies: HostProcessEvidenceDependencies = {},
): HostProcessLivenessEvidence {
  if (!expected || !Number.isInteger(expected.pid) || expected.pid <= 0) {
    return { expected: null, present: false, observedIdentity: null, cpuMs: null, cpuProgress: null, launchedAt: null };
  }
  const pidAlive = dependencies.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const identityOf = dependencies.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const cpuOf = dependencies.processCpuMs ?? ((pid: number) => procBackend.processCpuMs(pid));
  const present = pidAlive(expected.pid);
  const observedIdentity = present ? identityOf(expected.pid) : null;
  /* The launch clock comes from whichever identity is verifiable: the observed
     one when the process is still there, the recorded one when it is not. */
  const launchedAt = processLaunchedAt(observedIdentity ?? expected.startIdentity, {
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.uptimeSeconds ? { uptimeSeconds: dependencies.uptimeSeconds } : {}),
  });
  return {
    expected,
    present,
    observedIdentity,
    cpuMs: present ? cpuOf(expected.pid) : null,
    cpuProgress: null,
    launchedAt,
  };
}

interface CpuObservation {
  at: number;
  cpuMs: number;
  transcriptLastWriteAt: number | null;
}

type ProcessWithLivenessStore = NodeJS.Process & {
  __llvTurnLivenessCpuObservations?: Map<string, CpuObservation[]>;
};

const CPU_OBSERVATION_PROCESS_CAP = 2_048;
const CPU_OBSERVATION_SAMPLES_PER_PROCESS = 32;
const CPU_OBSERVATION_MIN_SAMPLE_INTERVAL_MS = 5_000;

function cpuObservationStore(): Map<string, CpuObservation[]> {
  const shared = process as ProcessWithLivenessStore;
  shared.__llvTurnLivenessCpuObservations ??= new Map();
  return shared.__llvTurnLivenessCpuObservations;
}

/** Recent CPU movement for one identity while the transcript itself stayed
    unchanged. Stored on the process object so separate Next server bundles in
    the same Viewer process share one observation history. */
export function observeHostCpuProgress(input: {
  process: ProcessIdentity;
  observedIdentity: string;
  cpuMs: number;
  transcriptLastWriteAt: number | null;
  now: number;
}): HostProcessLivenessEvidence["cpuProgress"] {
  const key = `${input.process.pid}:${input.observedIdentity}`;
  const store = cpuObservationStore();
  let samples = store.get(key);
  const previous = samples?.at(-1);
  if (!samples
    || !previous
    || input.now < previous.at
    || input.cpuMs < previous.cpuMs
    || input.transcriptLastWriteAt !== previous.transcriptLastWriteAt) {
    samples = [{ at: input.now, cpuMs: input.cpuMs, transcriptLastWriteAt: input.transcriptLastWriteAt }];
    if (!store.has(key) && store.size >= CPU_OBSERVATION_PROCESS_CAP) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, samples);
    return null;
  }
  if (input.now - previous.at >= CPU_OBSERVATION_MIN_SAMPLE_INTERVAL_MS) {
    samples.push({ at: input.now, cpuMs: input.cpuMs, transcriptLastWriteAt: input.transcriptLastWriteAt });
  }
  while (samples.length > 2 && input.now - samples[1]!.at >= LIVENESS_CPU_PROGRESS_WINDOW_MS) samples.shift();
  while (samples.length > CPU_OBSERVATION_SAMPLES_PER_PROCESS) samples.shift();
  const baseline = samples[0]!;
  const observedMs = input.now - baseline.at;
  if (observedMs < LIVENESS_CPU_PROGRESS_WINDOW_MS) return null;
  return { consumedMs: Math.max(0, input.cpuMs - baseline.cpuMs), observedMs };
}

export function resetHostCpuProgressForTests(): void {
  delete (process as ProcessWithLivenessStore).__llvTurnLivenessCpuObservations;
}

type RecordLike = Record<string, unknown>;

function claudeEventKind(record: RecordLike): TranscriptEventKind {
  const message = recordValue(record.message);
  const content = recordsValue(message?.content);
  if (record.type === "assistant") {
    return content.some((part) => part.type === "tool_use") ? "tool-call" : "assistant-message";
  }
  if (record.type === "user") {
    return content.some((part) => part.type === "tool_result") ? "tool-result" : "user-message";
  }
  return "other";
}

function codexEventKind(record: RecordLike): TranscriptEventKind {
  const payload = recordValue(record.payload) ?? {};
  const type = stringValue(payload.type) ?? "";
  if (type === "user_message") return "user-message";
  if (type === "agent_message") return "assistant-message";
  if (type.includes("output") || type.endsWith("_result")) return "tool-result";
  if (type.includes("tool") || type.includes("function") || type.includes("command")) return "tool-call";
  return "other";
}

/** The newest record's clock, its kind, and the turn axis its tail leaves. */
export function transcriptEvidenceFromRecords(
  records: RecordLike[],
  engine: "claude" | "codex",
  lastWriteAt: number | null,
): TranscriptLivenessEvidence {
  const turn = turnStateFromRecords(records, engine).state;
  const axis = turn === "busy" ? "busy" as const : turn === "terminal" ? "terminal" as const : "unknown" as const;
  const last = records.at(-1) ?? null;
  if (!last) return { lastEventAt: null, kind: null, lastWriteAt, turn: axis };
  const stamped = Date.parse(String(last.timestamp ?? ""));
  return {
    lastEventAt: Number.isFinite(stamped) ? stamped : lastWriteAt,
    kind: engine === "codex" ? codexEventKind(last) : claudeEventKind(last),
    lastWriteAt,
    turn: axis,
  };
}

function transcriptMtimeMs(transcriptPath: string): number | null {
  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
}

export async function readTranscriptEvidence(
  engine: "claude" | "codex",
  transcriptPath: string,
  read: typeof readStableTailRecords = readStableTailRecords,
): Promise<TranscriptLivenessEvidence> {
  if (!transcriptPath) return { lastEventAt: null, kind: null, lastWriteAt: null, turn: "unknown" };
  const lastWriteAt = transcriptMtimeMs(transcriptPath);
  const tail = await read(transcriptPath);
  /* An unparseable tail is not silence: the file's own clock still says whether
     this host has written since it launched. */
  if (tail.integrity !== "complete") return { lastEventAt: null, kind: null, lastWriteAt, turn: "unknown" };
  return transcriptEvidenceFromRecords(tail.records, engine, lastWriteAt);
}

/**
 * The whole decision, from evidence alone.
 *
 * Reading order matters: the transcript's own readability first (a turn nobody
 * can read is a turn nothing can be said about), then a closed turn (there is
 * nothing to sever), then process identity (a pid that is gone, or is now
 * somebody else's process, settles it), then writes since this host's own
 * launch, then CPU, then how long a delivery has waited. Nothing here reads
 * `live`, `idle` or `busy` off a row.
 */
export function decideTurnLiveness(evidence: TurnLivenessEvidence): TurnLivenessDecision {
  const { now, transcriptTail: transcript, host, delivery } = evidence;
  const context = {
    turn: transcript.turn,
    lastEvent: { kind: transcript.kind, at: transcript.lastEventAt },
  };
  /* Unreadable, corrupt, truncated or empty transcript evidence stops here.
     Every branch below sits behind this one, the four that reach `severed`
     included — a process that is gone, a pid that is now somebody else's, a
     host burning no CPU since its launch, a delivery that has waited (#1281).
     The reading that tempts the other way is that a missing process is
     definitive. It is definitive about the pid: that pid is not running. It
     says nothing about the turn, because a turn severed mid-work and a turn
     that finished long ago under a row nobody updated leave exactly this
     observation, and the transcript is the only thing that tells them apart.
     The costs are not symmetric either. A kill lands the same way in both
     readings, but a retry re-runs work that may already be complete, and a
     continuation nudge re-prompts a seat about a turn that is over. So the
     answer consumers get is `unknown`, which authorises none of it, rather than
     a verdict they are entitled to act on. */
  if (transcript.turn === "unknown") {
    return {
      ...context,
      state: "unknown",
      reason: "the transcript leaves no readable turn"
        + ` (last written ${when(transcript.lastWriteAt)}), so nothing here says whether a turn is in flight`,
      since: null,
    };
  }
  /* Settledness is a property of the turn, so it outranks everything about the
     process: a finished session whose host has since exited has nothing
     severed about it, and a seat in that state is owed no recovery (#1276). */
  if (transcript.turn === "terminal") {
    return {
      ...context,
      state: "settled",
      reason: `the transcript ends on a settled turn (${transcript.kind ?? "no records"} at ${when(transcript.lastEventAt)})`,
      since: transcript.lastEventAt,
    };
  }
  if (!host.expected) {
    return {
      ...context,
      state: "unknown",
      reason: "no process is recorded for this turn and its transcript leaves the turn open",
      since: null,
    };
  }
  /* A stable clock for the grace a consumer holds this against: the last thing
     the session is known to have done, falling back to the launch. */
  const severedSince = transcript.lastEventAt ?? host.launchedAt;
  if (!host.present) {
    return {
      ...context,
      state: "severed",
      reason: `the process recorded as owning this turn (pid ${host.expected.pid}) no longer exists;`
        + ` the transcript's last event is ${transcript.kind ?? "unreadable"} at ${when(transcript.lastEventAt)}`,
      since: severedSince ?? now,
    };
  }
  /* An identity that cannot be revalidated is not evidence about this process.
     The pid exists, but nothing here proves it is still the process the row was
     written about: the kernel did not answer, or the row never recorded a start
     identity to compare against. Every verdict below reads the recorded launch
     clock as this pid's own history, and the mismatch branch can only speak when
     both tokens are in hand. An unverifiable identity therefore answers
     `unknown`, which authorises no kill, no retry and no restart nudge on a pid
     that may by now belong to somebody else entirely (#1281). */
  if (host.observedIdentity === null || host.expected.startIdentity === null) {
    return {
      ...context,
      state: "unknown",
      reason: `pid ${host.expected.pid} exists, but ${host.expected.startIdentity === null
        ? "the registry recorded no start identity for it"
        : "the platform did not report its start identity"},`
        + " so nothing proves it is still the process this turn was handed to",
      since: null,
    };
  }
  if (host.observedIdentity !== host.expected.startIdentity) {
    return {
      ...context,
      state: "severed",
      reason: `pid ${host.expected.pid} is no longer the process the registry recorded for this turn`,
      since: severedSince ?? now,
    };
  }
  if (host.launchedAt === null) {
    return {
      ...context,
      state: "unknown",
      reason: `pid ${host.expected.pid} exists but its launch time is unreadable,`
        + " so nothing can be said about what it has done since",
      since: null,
    };
  }
  const wroteAt = Math.max(transcript.lastEventAt ?? 0, transcript.lastWriteAt ?? 0) || null;
  if (wroteAt !== null && wroteAt >= host.launchedAt) {
    /* However long the gap. A ten-minute tool call is a host that wrote its
       tool call and is waiting for it, so the gap is the work itself. */
    return {
      ...context,
      state: "working",
      reason: `this host wrote ${transcript.kind ?? "a record"} at ${when(wroteAt)}`
        + ` (${ago(now, wroteAt)}), after its own launch at ${when(host.launchedAt)}`,
      since: null,
    };
  }
  const ageMs = now - host.launchedAt;
  if (ageMs < LIVENESS_OBSERVATION_WINDOW_MS) {
    return {
      ...context,
      state: "unknown",
      reason: `pid ${host.expected.pid} launched ${Math.max(0, Math.round(ageMs / 1_000))}s ago`
        + " and has not had time to write anything",
      since: null,
    };
  }
  const outstandingSince = delivery.outstandingSince;
  const deliveryStalled = outstandingSince !== null
    && now - outstandingSince >= LIVENESS_OUTSTANDING_DELIVERY_MS;
  /* "Severed" is a statement about a turn, and by here there is one: the tail
     read says this host inherited a turn that is still open, and has written
     nothing since it launched — the specimen. A host with no turn to inherit
     never arrives here at all. A freshly launched one still waiting for its
     first prompt has an empty transcript, and one whose transcript cannot be
     read has no turn either; both leave `turn: "unknown"`, which the gate at
     the top of this function answers before any of this runs. */
  const inherited = `it has written nothing since its own launch at ${when(host.launchedAt)};`
    + ` the transcript's last event is ${transcript.kind ?? "unreadable"} at ${when(transcript.lastEventAt)}, before that launch`;
  const cpuProgress = host.cpuProgress;
  if (cpuProgress !== null) {
    const cpuPerMinute = cpuProgress.consumedMs / elapsedMinutes(cpuProgress.observedMs);
    if (cpuPerMinute >= LIVENESS_WORKING_CPU_MS_PER_MINUTE) {
      return {
        ...context,
        state: "working",
        reason: `this host consumed ${Math.round(cpuProgress.consumedMs)}ms of CPU during the latest`
          + ` ${Math.round(cpuProgress.observedMs / 1_000)}s with no transcript write`
          + ` (${Math.round(cpuPerMinute)}ms per minute)`,
        since: null,
      };
    }
    return {
      ...context,
      state: "severed",
      reason: `${inherited}, and it consumed only ${Math.round(cpuProgress.consumedMs)}ms of CPU during the latest`
        + ` ${Math.round(cpuProgress.observedMs / 1_000)}s (${Math.round(cpuPerMinute)}ms per minute)`,
      since: host.launchedAt,
    };
  }
  if (host.cpuMs !== null) {
    const cpuPerMinute = host.cpuMs / elapsedMinutes(ageMs);
    if (cpuPerMinute >= LIVENESS_WORKING_CPU_MS_PER_MINUTE) {
      return {
        ...context,
        state: "working",
        reason: `this host has consumed ${Math.round(host.cpuMs)}ms of CPU since its launch at ${when(host.launchedAt)}`
          + ` (${Math.round(cpuPerMinute)}ms per minute)`,
        since: null,
      };
    }
    return {
      ...context,
      state: "severed",
      reason: `${inherited}, and it has burned ${Math.round(host.cpuMs)}ms of CPU in ${Math.round(ageMs / 1_000)}s`
        + ` (${Math.round(cpuPerMinute)}ms per minute)`,
      since: host.launchedAt,
    };
  }
  if (deliveryStalled) {
    return {
      ...context,
      state: "severed",
      reason: `${inherited}, and a delivery has been outstanding for it since ${when(outstandingSince)}`
        + ` (${ago(now, outstandingSince)})`,
      since: host.launchedAt,
    };
  }
  return {
    ...context,
    state: "unknown",
    reason: `${inherited}, but this platform reports no CPU for pid ${host.expected.pid}, so nothing proves it idle`,
    since: null,
  };
}

export interface TurnLivenessInput {
  engine: "claude" | "codex";
  transcriptPath: string;
  process: ProcessIdentity | null;
  deliveryOutstandingSince?: number | null;
}

export interface TurnLivenessDependencies extends HostProcessEvidenceDependencies {
  readTranscript?: typeof readTranscriptEvidence;
}

export async function readTurnLiveness(
  input: TurnLivenessInput,
  dependencies: TurnLivenessDependencies = {},
): Promise<TurnLivenessDecision> {
  const evidence = await readTurnLivenessEvidence(input, dependencies);
  return decideTurnLiveness(evidence);
}

export async function readTurnLivenessEvidence(
  input: TurnLivenessInput,
  dependencies: TurnLivenessDependencies = {},
): Promise<TurnLivenessEvidence> {
  const now = (dependencies.now ?? Date.now)();
  /* Whatever this read says is the whole of the transcript evidence. A tail that
     could not be parsed leaves the turn `unknown`, and `unknown` is the answer —
     substituting the turn word a registry row carries would put the status word
     this decision exists to stop trusting back at the centre of it (#1281). A
     row inherits `busy` from whoever wrote it last, so an unreadable transcript
     plus a stale row was enough to call a turn severed, and a stale terminal one
     was enough to call it settled. */
  const transcript = await (dependencies.readTranscript ?? readTranscriptEvidence)(
    input.engine,
    input.transcriptPath,
  );
  const host = readHostProcessEvidence(input.process, dependencies);
  if (host.expected
    && host.present
    && host.observedIdentity !== null
    && host.observedIdentity === host.expected.startIdentity
    && host.cpuMs !== null) {
    host.cpuProgress = (dependencies.observeCpuProgress ?? observeHostCpuProgress)({
      process: host.expected,
      observedIdentity: host.observedIdentity,
      cpuMs: host.cpuMs,
      transcriptLastWriteAt: transcript.lastWriteAt,
      now,
    });
  }
  return {
    now,
    transcriptTail: transcript,
    host,
    delivery: { outstandingSince: input.deliveryOutstandingSince ?? null },
  };
}

/** When a delivery started waiting on this conversation, from the durable
    reservation ledger — the oldest one that has not settled. */
export function outstandingDeliverySince(
  snapshot: RegistryFile,
  conversationId: string,
): number | null {
  let earliest: number | null = null;
  for (const delivery of Object.values(snapshot.heldDeliveries)) {
    if (delivery.conversationId !== conversationId) continue;
    if (delivery.state !== "held" && delivery.state !== "assigned" && delivery.state !== "delivery-uncertain") continue;
    const at = Date.parse(delivery.createdAt);
    if (!Number.isFinite(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

export interface ConversationTurnLiveness extends TurnLivenessDecision {
  key: SessionKey;
  transcriptPath: string;
  process: ProcessIdentity | null;
  hostEvidence: HostProcessLivenessEvidence;
}

/**
 * The decision for one conversation's current generation, or null when the
 * registry has no structured host row to judge.
 */
export async function conversationTurnLiveness(
  registry: AgentRegistry,
  conversationId: string,
  dependencies: TurnLivenessDependencies & { snapshot?: RegistryFile } = {},
): Promise<ConversationTurnLiveness | null> {
  if (!conversationId.startsWith("conversation_")) return null;
  const snapshot = dependencies.snapshot ?? registry.readOnlySnapshot();
  const conversation = snapshot.conversations[registry.canonicalConversationId(conversationId as `conversation_${string}`)];
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  if (conversation.engine !== "claude" && conversation.engine !== "codex") return null;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const entry = snapshot.entries[sessionKeyId(key)];
  if (!entry?.structuredHost) return null;
  const evidence = await readTurnLivenessEvidence({
    engine: conversation.engine,
    transcriptPath: generation.path,
    process: entry.structuredHost.process ?? null,
    deliveryOutstandingSince: outstandingDeliverySince(snapshot, conversation.id),
  }, dependencies);
  const decision = decideTurnLiveness(evidence);
  return {
    ...decision,
    key,
    transcriptPath: generation.path,
    process: entry.structuredHost.process ?? null,
    hostEvidence: evidence.host,
  };
}
