import fs from "node:fs";

import { agentRegistry, type ProcessIdentity, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import {
  captureProcessIdentity,
  processIdentityStatus,
  sameRecordedProcessIdentity,
  systemBootEpoch,
  type ProcessIdentityProbe,
} from "@/lib/processIdentity";
import { RESOURCE_STRUCTURED_HOST_LIMIT } from "@/lib/types";
import type { StructuredHostKillRef, StructuredHostRecord } from "@/lib/resources";

import { hasStructuredDeliveryHost, terminateStructuredDeliveryHost } from "./structuredDeliveryController";

/**
 * The two things the resources rail needs from the structured transport:
 * what hosts exist right now, and how to end one.
 *
 * Both live here because both need the registry, and the collector that builds
 * the payload runs in a contained worker that must never open it. The viewer
 * reads the inventory, hands it to the collector, and later resolves a kill
 * against the snapshot that came back.
 */

/** Structured hosts the registry knows about, newest first and bounded. */
export function readStructuredHostRecords(dependencies: {
  snapshot?: () => RegistryFile;
  owned?: (key: SessionKey) => boolean;
} = {}): StructuredHostRecord[] {
  const file = (dependencies.snapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  const owned = dependencies.owned ?? hasStructuredDeliveryHost;
  const conversationsBySession = new Map<string, RegistryFile["conversations"][string]>();
  for (const conversation of Object.values(file.conversations)) {
    for (const generation of conversation.generations) conversationsBySession.set(generation.id, conversation);
  }
  const entries = Object.values(file.entries)
    .filter((entry) => Boolean(entry.structuredHost?.process)
      && (entry.key.engine === "claude" || entry.key.engine === "codex")
      /* A pane-hosted entry is already a tmux row; listing it twice would
         offer two kills for one process tree. */
      && entry.host === null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RESOURCE_STRUCTURED_HOST_LIMIT);

  return entries.map((entry) => {
    const process = entry.structuredHost!.process!;
    const conversation = conversationsBySession.get(entry.key.sessionId) ?? null;
    const generation = conversation?.generations.find((candidate) => candidate.id === entry.key.sessionId) ?? null;
    const memberships = conversation ? file.memberships[conversation.id] ?? [] : [];
    const pipeline = memberships.find((membership) => membership.kind === "pipeline") ?? null;
    return {
      id: sessionKeyId(entry.key),
      engine: entry.key.engine as "claude" | "codex",
      sessionId: entry.key.sessionId,
      pid: process.pid,
      startIdentity: process.startIdentity,
      bootEpoch: process.bootEpoch ?? null,
      cwd: entry.cwd || generation?.launchProfile.cwd || "",
      path: entry.artifactPath || null,
      conversationId: conversation?.id ?? null,
      title: generation?.launchProfile.title ?? null,
      role: conversation?.agentRole ?? pipeline?.role ?? generation?.launchProfile.role ?? null,
      model: generation?.launchProfile.model ?? null,
      stage: pipeline?.stageId ?? pipeline?.slot ?? null,
      seat: conversation === null ? null : memberships.some((membership) => membership.kind === "orchestrator"),
      turnBusy: conversation === null || conversation.turn.state === "unknown"
        ? null
        : conversation.turn.state === "busy",
      owned: owned(entry.key),
    } satisfies StructuredHostRecord;
  });
}

/**
 * What the registry says about one host *right now*, for the checks a bulk
 * kill must not take from a snapshot that may be minutes old.
 */
interface CurrentStructuredHostState {
  seat: boolean | null;
  turnBusy: boolean | null;
  /** Transcript mtime in ms, the same "no activity for the threshold" clock
      the dialog shows; null when nothing names a transcript to read. */
  lastActiveMs: number | null;
}

export interface StructuredHostKillGateDependencies {
  snapshot?: () => RegistryFile;
  transcriptMtimeMs?: (path: string) => number | null;
  processIdentity?: (pid: number) => string | null;
  now?: () => number;
}

function transcriptMtimeMs(path: string): number | null {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function currentStructuredHostState(
  key: SessionKey,
  expected: Readonly<ProcessIdentity>,
  dependencies: StructuredHostKillGateDependencies,
): CurrentStructuredHostState | null {
  const file = (dependencies.snapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  const entry = file.entries[sessionKeyId(key)] ?? null;
  const process = entry?.structuredHost?.process ?? null;
  if (process === null || !sameRecordedProcessIdentity(process, expected)) return null;
  const conversation = Object.values(file.conversations)
    .find((candidate) => candidate.generations.some((generation) => generation.id === key.sessionId)) ?? null;
  if (!entry && !conversation) return null;
  const memberships = conversation ? file.memberships[conversation.id] ?? [] : [];
  const artifactPath = entry?.artifactPath || null;
  return {
    seat: conversation === null ? null : memberships.some((membership) => membership.kind === "orchestrator"),
    turnBusy: conversation === null || conversation.turn.state === "unknown"
      ? null
      : conversation.turn.state === "busy",
    lastActiveMs: artifactPath ? (dependencies.transcriptMtimeMs ?? transcriptMtimeMs)(artifactPath) : null,
  };
}

/** Which gesture is asking, because they promise different things: a row kill
    is the operator naming one host, "kill idle" promises the host is settled
    and quiet, and "kill all" promises only that untouched seats survive. */
export type StructuredHostKillIntent =
  | { kind: "row" }
  | { kind: "idle"; hours: number }
  | { kind: "all" };

/**
 * The last snapshot says what may be killed; this says whether it still may.
 *
 * The rail polls every 30 s and its observation may be minutes old, so a host
 * that has since taken the orchestrator seat, started a turn or written to its
 * transcript would otherwise be swept up by a bulk kill that was promised the
 * opposite. Every one of those facts is re-read from the registry here, one
 * step before the signal.
 */
export function structuredHostKillRefusal(
  ref: StructuredHostKillRef,
  intent: StructuredHostKillIntent,
  includeSeat: boolean,
  dependencies: StructuredHostKillGateDependencies = {},
): { status: 409; error: string } | null {
  const current = ref.sessionId === null
    ? null
    : currentStructuredHostState(
        { engine: ref.engine, sessionId: ref.sessionId },
        { pid: ref.pid, startIdentity: ref.startIdentity, bootEpoch: ref.bootEpoch },
        dependencies,
      );
  /* A seat either side of the snapshot counts: one taken since collection is
     not in the ref, and one given up since may still be mid-handoff. */
  if ((current?.seat ?? false) || ref.seat) {
    if (!includeSeat) return { status: 409, error: "this host is a live orchestrator seat — tick it to include it" };
  }
  if (intent.kind !== "row" && ((ref.sessionId === null && ref.seat !== true)
    || ref.seat === null
    || (ref.sessionId !== null && (current === null || current.seat === null)))) {
    return { status: 409, error: "this host's orchestrator-seat status is unknown — kill it from its own row" };
  }
  if (intent.kind !== "idle") return null;
  if (current === null) {
    return { status: 409, error: "this host has no idle age to prove — kill it from its own row" };
  }
  if (current.turnBusy) {
    return { status: 409, error: "this host is mid-turn — refresh the resource list" };
  }
  if (current.turnBusy === null) {
    return { status: 409, error: "this host's turn state is unknown — kill it from its own row" };
  }
  if (current.lastActiveMs === null) {
    return { status: 409, error: "this host has no idle age to prove — kill it from its own row" };
  }
  const cutoff = (dependencies.now ?? Date.now)() - intent.hours * 3_600_000;
  if (current.lastActiveMs >= cutoff) {
    return { status: 409, error: "this host has been active since the resource list was taken" };
  }
  return null;
}

/** How long a host may take to honour SIGTERM before the tree is force-killed. */
const TERMINATION_GRACE_MS = 400;
/** How long the whole ladder may run before the survivors are reported as-is. */
const TERMINATION_DEADLINE_MS = 3_000;
const TERMINATION_POLL_MS = 25;

export type StructuredHostTerminationOutcome =
  | { ok: true; via: "runtime" | "process-group" | "already-exited"; pids: number[] }
  | {
      ok: false;
      status: 403 | 409 | 500;
      error: string;
      /** Pids that prevented completion: surviving authorized processes or a
          pid whose kernel identity changed before the next signal. */
      remaining: number[];
      /** The authority this target carried is spent: the pid is no longer the
          process the snapshot listed, so the target is consumed, not retried. */
      stale?: true;
    };

export interface StructuredHostTerminationDependencies {
  processIdentity?(pid: number): string | null;
  bootEpoch?(): string | null;
  pidAlive?(pid: number): boolean;
  ppidMap?(): Map<number, number>;
  processGroupId?(pid: number): number | null;
  signal?(pid: number, signal: NodeJS.Signals): void;
  terminateOwnedHost?(key: SessionKey, expected: ProcessIdentity): Promise<boolean>;
  retireRegistryEntry?(key: SessionKey, expected: ProcessIdentity): void;
  protectedPids?(): Set<number>;
  sleep?(ms: number): Promise<void>;
  graceMs?: number;
  deadlineMs?: number;
}

function linuxProcessGroupId(pid: number): number | null {
  if (procBackend.name !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const group = Number(stat.slice(close + 2).trim().split(/\s+/)[2]);
    return Number.isInteger(group) && group > 0 ? group : null;
  } catch {
    return null;
  }
}

/**
 * The viewer, the runtime host that started it, and the shell that started
 * that: the processes a kill must never reach whatever a snapshot claimed. A
 * host is spawned detached, so it can never be one of our own ancestors —
 * finding a pid here means the snapshot is wrong, and refusing is the answer.
 */
function ownAncestry(): Set<number> {
  const ancestry = new Set<number>([process.pid]);
  let pid: number | null = process.pid;
  for (let depth = 0; depth < 32 && pid !== null; depth += 1) {
    pid = procBackend.readPpid(pid);
    if (pid !== null) ancestry.add(pid);
  }
  return ancestry;
}

/** A signal that lost its race with an exiting process changed nothing; any
    other refusal (EPERM above all) means the tree outlived the attempt and
    the caller must hear about it rather than read success. */
function signalErrorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Ends one structured host and everything under it.
 *
 * Through the runtime's own lifecycle when it still holds *this* host — that
 * releases the engine host and retires the registry row in one move — and by
 * process group when it does not, which is the only thing that reaches a
 * released or orphaned host (`conversation_action kill` answers "structured
 * runtime host is unavailable" for those, #1199). Either way the sweep runs:
 * the `nsenter`/`setpriv`/shell wrapper and every descendant get SIGTERM once,
 * then SIGKILL once for whatever is still standing. The registry row is retired
 * only when the tree is confirmed gone, and only while it still names the pid
 * this kill was authorized for.
 */
export async function terminateStructuredHostTree(
  ref: StructuredHostKillRef,
  dependencies: StructuredHostTerminationDependencies = {},
): Promise<StructuredHostTerminationOutcome> {
  const identityOf = dependencies.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const alive = dependencies.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const bootEpoch = dependencies.bootEpoch ?? systemBootEpoch;
  const identityProbe: ProcessIdentityProbe = { processIdentity: identityOf, pidAlive: alive, bootEpoch };
  const ppids = dependencies.ppidMap ?? (() => procBackend.ppidMap());
  const groupOf = dependencies.processGroupId ?? linuxProcessGroupId;
  const signal = dependencies.signal ?? ((pid: number, value: NodeJS.Signals) => { process.kill(pid, value); });
  const retire = dependencies.retireRegistryEntry
    ?? ((key: SessionKey, expected: ProcessIdentity) => { agentRegistry().terminateStructuredHost(key, expected); });
  const terminateOwned = dependencies.terminateOwnedHost ?? terminateStructuredDeliveryHost;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = dependencies.graceMs ?? TERMINATION_GRACE_MS;
  const deadlineMs = dependencies.deadlineMs ?? TERMINATION_DEADLINE_MS;

  const { pid } = ref;
  if (!Number.isSafeInteger(pid) || pid <= 1) return { ok: false, status: 409, error: "host pid is invalid", remaining: [] };
  if (typeof ref.startIdentity !== "string" || ref.startIdentity.length === 0) {
    return { ok: false, status: 409, error: "host process identity is unknown — refresh the resource list", remaining: [] };
  }
  if (typeof ref.bootEpoch !== "string" || ref.bootEpoch.length === 0) {
    return { ok: false, status: 409, error: "host boot epoch is unknown — refresh the resource list", remaining: [] };
  }
  if ((dependencies.protectedPids ?? ownAncestry)().has(pid)) {
    return { ok: false, status: 403, error: "this pid belongs to the viewer's own process chain", remaining: [] };
  }
  const key: SessionKey | null = ref.sessionId ? { engine: ref.engine, sessionId: ref.sessionId } : null;
  const expected: ProcessIdentity = { pid, startIdentity: ref.startIdentity, bootEpoch: ref.bootEpoch };

  const initialStatus = processIdentityStatus(expected, identityProbe);
  if (initialStatus === "dead" && !alive(pid)) {
    if (key) retire(key, expected);
    return { ok: true, via: "already-exited", pids: [] };
  }
  if (initialStatus === "unverified") {
    return { ok: false, status: 409, error: "host process identity cannot be verified — refresh the resource list", remaining: [] };
  }
  /* The fence the whole endpoint rests on: this pid must still be the process
     the snapshot listed, or the kernel handed it to something else. */
  if (initialStatus === "dead") {
    return { ok: false, status: 409, error: "host has changed — refresh the resource list", remaining: [], stale: true };
  }

  /* Snapshot the tree before anything dies: a reparented child is invisible to
     a ppid walk taken after the root is gone. */
  const processParents = ppids();
  const tree = descendantPids(pid, processParents);
  /* A host is spawned detached, so it leads its own group. Signalling the
     group reaches reparented members that a descendant walk cannot see. Add
     every observed member to the identity snapshot before granting that wider
     signal; any observed member without a verifiable identity refuses the kill. */
  const groupLeader = groupOf(pid) === pid ? pid : null;
  if (groupLeader !== null) {
    const known = new Set(tree);
    for (const candidate of processParents.keys()) {
      if (!known.has(candidate) && groupOf(candidate) === groupLeader) {
        known.add(candidate);
        tree.push(candidate);
      }
    }
  }
  const identities = new Map<number, ProcessIdentity>();
  for (const candidate of tree) {
    const candidateIdentity = identityOf(candidate);
    if (candidateIdentity !== null) {
      if (candidate === pid && candidateIdentity !== ref.startIdentity) {
        return {
          ok: false,
          status: 409,
          error: "host process identity changed before signalling — refresh the resource list",
          remaining: [pid],
          stale: true,
        };
      }
      identities.set(candidate, captureProcessIdentity(candidate, identityProbe, candidateIdentity));
      continue;
    }
    if (alive(candidate)) {
      return {
        ok: false,
        status: 409,
        error: `process ${candidate} identity is unknown — refresh the resource list`,
        remaining: [candidate],
      };
    }
  }
  const identityRefusal = (): Extract<StructuredHostTerminationOutcome, { ok: false }> | null => {
    for (const [candidate, expectedIdentity] of identities) {
      const status = processIdentityStatus(expectedIdentity, identityProbe);
      if (status === "alive" || (status === "dead" && !alive(candidate))) continue;
      return {
        ok: false,
        status: 409,
        error: status === "unverified"
          ? candidate === pid
            ? "host process identity cannot be verified before signalling — refresh the resource list"
            : `process ${candidate} identity cannot be verified before signalling — refresh the resource list`
          : candidate === pid
            ? "host process identity changed before signalling — refresh the resource list"
            : `process ${candidate} identity changed before signalling — refresh the resource list`,
        remaining: [candidate],
        ...(candidate === pid ? { stale: true as const } : {}),
      };
    }
    return null;
  };
  /* Ownership is asked at kill time, never read off the snapshot: the seat may
     have been given up since it was taken, or given to a replacement host —
     which is why the process this kill was authorized for goes with the ask.
     False means nothing the runtime holds is ours to end through it: the
     released/orphaned case, which only the process group reaches. */
  let via: "runtime" | "process-group" = "process-group";
  let runtimeFailure = false;
  if (key) {
    try {
      if (await terminateOwned(key, expected)) via = "runtime";
    } catch {
      runtimeFailure = true;
      const changed = identityRefusal();
      if (changed) return changed;
    }
  }

  /* The runtime path may await health/release work. The pid must cross the
     kernel identity fence again after that boundary: a session key may have
     been rebound while we waited, and a recycled group leader must never
     receive the fallback signal. */
  const changedAfterRuntime = identityRefusal();
  if (changedAfterRuntime) return changedAfterRuntime;

  const survivors = () => tree.filter((candidate) => alive(candidate));
  const refusals: string[] = [];
  const signalOnce = (target: number, value: NodeJS.Signals) => {
    try {
      signal(target, value);
    } catch (error) {
      const code = signalErrorCode(error);
      /* ESRCH is the process exiting between the check and the signal. */
      if (code !== "ESRCH") refusals.push(`${value} on ${target < 0 ? `group ${-target}` : target}: ${code ?? "failed"}`);
    }
  };
  /* Exactly one signal per process: the group signal already reaches every
     member, so only the descendants that left it (a child that called
     setsid, a reparented grandchild) are signalled individually. */
  const sweep = (value: NodeJS.Signals): Extract<StructuredHostTerminationOutcome, { ok: false }> | null => {
    const changed = identityRefusal();
    if (changed) return changed;
    const standing = survivors();
    if (groupLeader !== null && standing.some((candidate) => groupOf(candidate) === groupLeader)) {
      signalOnce(-groupLeader, value);
    }
    for (const candidate of standing) {
      if (groupLeader !== null && groupOf(candidate) === groupLeader) continue;
      signalOnce(candidate, value);
    }
    return null;
  };

  const changedBeforeTerm = sweep("SIGTERM");
  if (changedBeforeTerm) return changedBeforeTerm;
  const startedAt = Date.now();
  let escalated = false;
  while (survivors().length > 0) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) break;
    if (!escalated && elapsed >= graceMs) {
      escalated = true;
      const changedBeforeKill = sweep("SIGKILL");
      if (changedBeforeKill) return changedBeforeKill;
    }
    await sleep(TERMINATION_POLL_MS);
  }

  const changedBeforeResult = identityRefusal();
  if (changedBeforeResult) return changedBeforeResult;
  const remaining = survivors();
  if (remaining.length > 0 || refusals.length > 0) {
    /* Partial is not success: the registry row keeps describing the host that
       is still running, and the target keeps its authority for a retry. */
    let error: string;
    if (runtimeFailure) error = "the runtime host termination failed and the process tree survived";
    else if (refusals.length > 0) error = `the kill was refused (${refusals[0]})`;
    else error = `${remaining.length} process${remaining.length === 1 ? "" : "es"} outlived the kill`;
    return {
      ok: false,
      status: 500,
      error,
      remaining,
    };
  }
  /* The runtime path already retired the row as part of its own lifecycle. */
  if (key && via !== "runtime") retire(key, expected);
  return { ok: true, via, pids: tree };
}
