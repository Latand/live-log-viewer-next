import fs from "node:fs";

import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { signalProcessGroup } from "@/lib/processGroup";
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
      cwd: entry.cwd || generation?.launchProfile.cwd || "",
      path: entry.artifactPath || null,
      conversationId: conversation?.id ?? null,
      title: generation?.launchProfile.title ?? null,
      role: conversation?.agentRole ?? pipeline?.role ?? generation?.launchProfile.role ?? null,
      model: generation?.launchProfile.model ?? null,
      stage: pipeline?.stageId ?? pipeline?.slot ?? null,
      seat: memberships.some((membership) => membership.kind === "orchestrator"),
      turnBusy: conversation?.turn.state === "busy",
      owned: owned(entry.key),
    } satisfies StructuredHostRecord;
  });
}

/** How long a host may take to honour SIGTERM before the tree is force-killed. */
const TERMINATION_GRACE_MS = 400;
/** How long the whole ladder may run before the survivors are reported as-is. */
const TERMINATION_DEADLINE_MS = 3_000;
const TERMINATION_POLL_MS = 25;

export type StructuredHostTerminationOutcome =
  | { ok: true; via: "runtime" | "process-group" | "already-exited"; pids: number[]; remaining: number[] }
  | { ok: false; status: 403 | 409; error: string };

export interface StructuredHostTerminationDependencies {
  processIdentity?(pid: number): string | null;
  pidAlive?(pid: number): boolean;
  ppidMap?(): Map<number, number>;
  processGroupId?(pid: number): number | null;
  signal?(pid: number, signal: NodeJS.Signals): void;
  terminateOwnedHost?(key: SessionKey): Promise<boolean>;
  retireRegistryEntry?(key: SessionKey): void;
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

/**
 * Ends one structured host and everything under it.
 *
 * Through the runtime's own lifecycle when it still holds the host — that
 * releases the engine host and retires the registry row in one move — and by
 * process group when it does not, which is the only thing that reaches a
 * released or orphaned host (`conversation_action kill` answers "structured
 * runtime host is unavailable" for those, #1199). Either way the sweep runs:
 * the `nsenter`/`setpriv`/shell wrapper and every descendant get SIGTERM, then
 * SIGKILL for whatever is still standing, and the registry row is retired so
 * the card settles honestly.
 */
export async function terminateStructuredHostTree(
  ref: StructuredHostKillRef,
  dependencies: StructuredHostTerminationDependencies = {},
): Promise<StructuredHostTerminationOutcome> {
  const identityOf = dependencies.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const alive = dependencies.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const ppids = dependencies.ppidMap ?? (() => procBackend.ppidMap());
  const groupOf = dependencies.processGroupId ?? linuxProcessGroupId;
  const signal = dependencies.signal ?? ((pid: number, value: NodeJS.Signals) => { process.kill(pid, value); });
  const retire = dependencies.retireRegistryEntry ?? ((key: SessionKey) => { agentRegistry().terminateStructuredHost(key); });
  const terminateOwned = dependencies.terminateOwnedHost ?? terminateStructuredDeliveryHost;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = dependencies.graceMs ?? TERMINATION_GRACE_MS;
  const deadlineMs = dependencies.deadlineMs ?? TERMINATION_DEADLINE_MS;

  const { pid } = ref;
  if (!Number.isSafeInteger(pid) || pid <= 1) return { ok: false, status: 409, error: "host pid is invalid" };
  if ((dependencies.protectedPids ?? ownAncestry)().has(pid)) {
    return { ok: false, status: 403, error: "this pid belongs to the viewer's own process chain" };
  }
  const key: SessionKey | null = ref.sessionId ? { engine: ref.engine, sessionId: ref.sessionId } : null;

  const observed = identityOf(pid);
  if (observed === null && !alive(pid)) {
    if (key) retire(key);
    return { ok: true, via: "already-exited", pids: [], remaining: [] };
  }
  if (ref.startIdentity !== null && observed !== null && observed !== ref.startIdentity) {
    return { ok: false, status: 409, error: "host has changed — refresh the resource list" };
  }

  /* Snapshot the tree before anything dies: a reparented child is invisible to
     a ppid walk taken after the root is gone. */
  const tree = descendantPids(pid, ppids());
  /* A host is spawned detached, so it leads its own group. Signalling the
     group is what reaches the wrapper's own children; signalling any other
     group could reach the operator's shell, so it is simply not done. */
  const groupLeader = groupOf(pid) === pid ? pid : null;

  /* Ownership is asked at kill time, never read off the snapshot: the seat may
     have been given up since it was taken. False means no registration owns the
     key — the released/orphaned case, which only the process group reaches. */
  let via: "runtime" | "process-group" = "process-group";
  if (key && await terminateOwned(key)) via = "runtime";

  const survivors = () => tree.filter((candidate) => alive(candidate));
  const sweep = (value: NodeJS.Signals) => {
    if (groupLeader !== null) signalProcessGroup(groupLeader, value, signal);
    for (const candidate of survivors()) {
      try {
        signal(candidate, value);
      } catch {
        /* exited between the survivor check and the signal */
      }
    }
  };

  sweep("SIGTERM");
  const startedAt = Date.now();
  let escalated = false;
  while (survivors().length > 0) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) break;
    if (!escalated && elapsed >= graceMs) {
      escalated = true;
      sweep("SIGKILL");
    }
    await sleep(TERMINATION_POLL_MS);
  }

  if (key) retire(key);
  return { ok: true, via, pids: tree, remaining: survivors() };
}
