import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { statePath } from "@/lib/configDir";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { RegistryFile, SpawnReceipt } from "./registry";
import { VIEWER_SPAWN_ENDPOINT } from "./spawnPolicy";

/** Roles with zero child-spawn capability (#393). A hardcoded contract
    constant: role overrides only carry config/promptScaffold, so no
    persisted preset can widen this set. */
export const SPAWN_DENIED_ROLE_IDS: readonly string[] = Object.freeze(["reviewer", "verifier"]);

export function isSpawnDeniedRole(role: string | null | undefined): boolean {
  return typeof role === "string" && SPAWN_DENIED_ROLE_IDS.includes(role);
}

export type SpawnRejectionCode = "reviewer_origin_spawn" | "nesting_depth_exceeded";

/** Who initiated a launch. Enforcement keys on this declared/authenticated
    initiator — never on the lineage parent, which may legitimately be a
    reviewer transcript (pipeline stages chain through the last passed stage). */
export type SpawnOrigin =
  | { kind: "operator" }
  | { kind: "agent"; conversationId: ViewerConversationId }
  | { kind: "container"; container: "pipeline" | "flow"; containerId: string; creatorConversationId: ViewerConversationId | null }
  | { kind: "external" }
  | { kind: "successor" };

export interface SpawnRejection {
  code: SpawnRejectionCode;
  origin: {
    kind: "agent" | "container";
    conversationId: ViewerConversationId | null;
    role: string | null;
    depth: number;
  };
  requestedRole: string | null;
  /** Depth the child would have had. */
  childDepth: number;
  /** Policy ceiling at rejection time. */
  maxDepth: number;
  guidance: string;
  rejectedAt: string;
}

/** A request-bound admission refusal written before a launch reservation. The
    fence is deliberately separate from SpawnReceipt: it prevents a late
    reservation for the same downstream key while keeping launch-receipt counts
    truthful at zero. */
export interface SpawnAdmissionFence {
  version: 1;
  clientAttemptId: string;
  requestDigest: string;
  status: number;
  error: string;
  rejectedAt: string;
}

export type SpawnAdmissionFenceResult =
  | { kind: "fenced"; fence: SpawnAdmissionFence }
  | { kind: "existing-receipt"; receipt: SpawnReceipt }
  | { kind: "conflict" };

export class SpawnAdmissionFenceError extends Error {
  constructor(readonly fence: SpawnAdmissionFence) {
    super(fence.error);
    this.name = "SpawnAdmissionFenceError";
  }
}

export class SpawnAdmissionFenceConflictError extends Error {
  constructor() {
    super("spawn attempt conflicts with its original request");
    this.name = "SpawnAdmissionFenceConflictError";
  }
}

interface SpawnAdmissionFenceFile {
  version: 1;
  fences: Record<string, SpawnAdmissionFence>;
}

function spawnAdmissionFencePath(): string {
  return statePath("spawn-admission-fences.json");
}

function emptySpawnAdmissionFenceFile(): SpawnAdmissionFenceFile {
  return { version: 1, fences: {} };
}

function validClientAttemptId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function normalizeSpawnAdmissionFence(value: unknown, key: string): SpawnAdmissionFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid spawn admission fence");
  const fence = value as Partial<SpawnAdmissionFence>;
  const status = fence.status;
  if (fence.version !== 1
    || fence.clientAttemptId !== key
    || typeof fence.clientAttemptId !== "string"
    || !validClientAttemptId(fence.clientAttemptId)
    || typeof fence.requestDigest !== "string"
    || !/^[0-9a-f]{64}$/i.test(fence.requestDigest)
    || typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499
    || typeof fence.error !== "string" || !fence.error.trim() || fence.error.length > 500
    || typeof fence.rejectedAt !== "string" || !fence.rejectedAt) {
    throw new Error("invalid spawn admission fence");
  }
  return {
    version: 1,
    clientAttemptId: fence.clientAttemptId,
    requestDigest: fence.requestDigest.toLowerCase(),
    status,
    error: fence.error,
    rejectedAt: fence.rejectedAt,
  };
}

function readSpawnAdmissionFenceFile(requestedClientAttemptId?: string): SpawnAdmissionFenceFile {
  let raw: string;
  try {
    raw = fs.readFileSync(spawnAdmissionFencePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySpawnAdmissionFenceFile();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("spawn admission fence store could not be read", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || !((parsed as { fences?: unknown }).fences)
    || typeof (parsed as { fences: unknown }).fences !== "object"
    || Array.isArray((parsed as { fences: unknown }).fences)) {
    throw new Error("spawn admission fence store has an unsupported schema");
  }
  const fences: Record<string, SpawnAdmissionFence> = {};
  for (const [key, value] of Object.entries((parsed as { fences: Record<string, unknown> }).fences)) {
    try {
      fences[key] = normalizeSpawnAdmissionFence(value, key);
    } catch (error) {
      /* A damaged entry must still make recovery of that exact key unknown.
         An unrelated damaged key has no bearing on this lookup and must not
         turn every new reservation into a 500. A later atomic write drops the
         unusable entry from the normalized file. */
      if (key === requestedClientAttemptId) throw error;
    }
  }
  return { version: 1, fences };
}

function writeSpawnAdmissionFenceFile(file: SpawnAdmissionFenceFile): void {
  const filename = spawnAdmissionFencePath();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

/** Read one durable fence. An unreadable store throws so recovery keeps the
    original outcome unknown. */
export function readSpawnAdmissionFence(clientAttemptId: string): SpawnAdmissionFence | null {
  if (!validClientAttemptId(clientAttemptId)) return null;
  return readSpawnAdmissionFenceFile(clientAttemptId).fences[clientAttemptId] ?? null;
}

/** Atomically persist a validation refusal only when no downstream launch
    receipt already owns the same key. The caller supplies that read so the
    fence and the route's reservation share the existing account lock. */
export function recordSpawnAdmissionRejection(input: {
  clientAttemptId: string;
  requestDigest: string;
  status: number;
  error: string;
  rejectedAt?: string;
}, currentReceipt: () => SpawnReceipt | null): SpawnAdmissionFenceResult {
  if (!validClientAttemptId(input.clientAttemptId)) throw new Error("invalid spawn admission fence clientAttemptId");
  if (!/^[0-9a-f]{64}$/i.test(input.requestDigest)) throw new Error("invalid spawn admission fence request digest");
  if (!Number.isInteger(input.status) || input.status < 400 || input.status > 499) throw new Error("invalid spawn admission fence status");
  const error = input.error.trim().slice(0, 500);
  if (!error) throw new Error("spawn admission fence error is required");
  return withAccountMutationLock(() => {
    const existingReceipt = currentReceipt();
    if (existingReceipt) return { kind: "existing-receipt", receipt: existingReceipt };
    const file = readSpawnAdmissionFenceFile(input.clientAttemptId);
    const existing = file.fences[input.clientAttemptId];
    const requestDigest = input.requestDigest.toLowerCase();
    if (existing) {
      return existing.requestDigest === requestDigest
        ? { kind: "fenced", fence: existing }
        : { kind: "conflict" };
    }
    const fence: SpawnAdmissionFence = {
      version: 1,
      clientAttemptId: input.clientAttemptId,
      requestDigest,
      status: input.status,
      error,
      rejectedAt: input.rejectedAt ?? new Date().toISOString(),
    };
    file.fences[input.clientAttemptId] = fence;
    writeSpawnAdmissionFenceFile(file);
    return { kind: "fenced", fence };
  });
}

/** Typed terminal admission rejection (#393): the receipt is durable and
    terminal, and no conversation, lineage edge, membership, transcript, or
    process exists for it. */
export class SpawnAdmissionError extends Error {
  constructor(readonly receipt: SpawnReceipt, readonly rejection: SpawnRejection) {
    super(rejection.guidance);
    this.name = "SpawnAdmissionError";
  }
}

export function reviewerOriginSpawnGuidance(role: string | null): string {
  const label = role === "verifier" ? "Verifier" : "Reviewer";
  return `${label} sessions run every check in-session — filesystem, shell, GitHub, and browser access stay available, but child agents do not. For more perspectives, report the need to your parent so an operator or orchestrator adds a visible reviewer stage (POST /api/pipelines or POST ${VIEWER_SPAWN_ENDPOINT}).`;
}

export function nestingDepthGuidance(childDepth: number, maxDepth: number): string {
  return `Agent nesting is capped at depth ${maxDepth} and this launch would create a depth-${childDepth} child. Finish delegated work in-session or report the need to your parent. An operator can raise maxAgentNestingDepth in Viewer spawn settings (PATCH /api/spawn/policy).`;
}

type AdmissionFileView = Pick<RegistryFile, "conversations" | "conversationAliases" | "lineageEdges" | "memberships">;

function canonicalId(file: AdmissionFileView, id: ViewerConversationId): ViewerConversationId {
  const seen = new Set<ViewerConversationId>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const next = file.conversationAliases[current];
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Durable role of a conversation, resolved fail-open for legacy records:
    the recorded conversation role, else its lineage-edge role, else its
    newest membership role, else null (unknown ≠ reviewer). */
export function conversationAgentRole(file: AdmissionFileView, id: ViewerConversationId): string | null {
  const canonical = canonicalId(file, id);
  const recorded = file.conversations[canonical]?.agentRole;
  if (typeof recorded === "string" && recorded.trim()) return recorded;
  const edgeRole = file.lineageEdges[canonical]?.role;
  if (typeof edgeRole === "string" && edgeRole.trim()) return edgeRole;
  const memberships = file.memberships[canonical] ?? [];
  const newest = [...memberships].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return newest?.role ?? null;
}

const LEGACY_DEPTH_WALK_CAP = 8;

/** Delegation depth of a conversation. Recorded-at-birth depth wins; legacy
    records fall back to container membership (⇒ 1 — pipeline lineage chains
    stage-to-stage, so an edge walk would overcount container children) and
    then a bounded, cycle-guarded lineage-edge walk. */
export function conversationDelegationDepth(file: AdmissionFileView, id: ViewerConversationId): number {
  const canonical = canonicalId(file, id);
  const recorded = file.conversations[canonical]?.delegationDepth;
  if (Number.isInteger(recorded) && recorded! >= 0) return recorded!;
  if ((file.memberships[canonical] ?? []).length > 0) return 1;
  let depth = 0;
  const seen = new Set<ViewerConversationId>([canonical]);
  let current = canonical;
  while (depth < LEGACY_DEPTH_WALK_CAP) {
    const edge = file.lineageEdges[current];
    if (!edge || edge.source !== "viewer-spawn") break;
    const parent = canonicalId(file, edge.parentConversationId);
    if (seen.has(parent)) break;
    seen.add(parent);
    depth += 1;
    const parentRecorded = file.conversations[parent]?.delegationDepth;
    if (Number.isInteger(parentRecorded) && parentRecorded! >= 0) return parentRecorded! + depth;
    current = parent;
  }
  return depth;
}

export interface ResolvedSpawnOrigin {
  kind: "agent" | "container";
  conversationId: ViewerConversationId | null;
  role: string | null;
  depth: number;
}

/** Role and depth of the initiating origin, for the origin kinds that are
    subject to admission. Operator/external/successor origins are roots. */
export function resolveSpawnOrigin(file: AdmissionFileView, origin: SpawnOrigin): ResolvedSpawnOrigin | null {
  if (origin.kind !== "agent" && origin.kind !== "container") return null;
  const originConversationId = origin.kind === "agent" ? origin.conversationId : origin.creatorConversationId;
  const canonical = originConversationId ? canonicalId(file, originConversationId) : null;
  return {
    kind: origin.kind,
    conversationId: canonical,
    role: canonical ? conversationAgentRole(file, canonical) : null,
    depth: canonical ? conversationDelegationDepth(file, canonical) : 0,
  };
}
