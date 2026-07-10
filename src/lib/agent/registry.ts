import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import {
  emptyLaunchProfile,
  type AutoBalancePolicy,
  type ConversationMigration,
  type DurableQuotaObservation,
  type HeldDelivery,
  type LaunchProfile,
  type MigrationIntent,
  type MigrationOrigin,
  type NativeGeneration,
  type TurnState,
  type ViewerConversationId,
} from "@/lib/accounts/migration/contracts";

import type { AgentEngine } from "./cli";
import { sessionKeyId, type SessionKey } from "./sessionKey";
import type { ResumePaneRecord } from "@/lib/resumePanesFile";

export type AgentHostStatus = "starting" | "live" | "idle" | "handoff" | "unhosted" | "dead";

export interface ProcessIdentity {
  pid: number;
  startIdentity: string | null;
}

export interface TmuxHostEvidence {
  kind: "tmux";
  endpoint: string;
  server: ProcessIdentity;
  paneId: string;
  panePid: ProcessIdentity;
  windowName: string;
  agent: ProcessIdentity;
  argv: string[];
}

/** Immutable tmux facts captured before readiness polling can expose a new
    pane to the observer. They are the only durable correlation between a
    launch receipt and an externally observed host. */
export interface TmuxSpawnBinding {
  endpoint: string;
  server: ProcessIdentity;
  paneId: string;
  panePid: ProcessIdentity;
  /** Current human-readable coordinates at creation time. */
  display?: string;
  /** Stable actuation target. Normalization upgrades legacy coordinates to paneId. */
  target: string;
}

export interface AgentRegistryEntry {
  key: SessionKey;
  artifactPath: string;
  cwd: string;
  accountId: string | null;
  launchProfile?: LaunchProfile;
  status: AgentHostStatus;
  host: TmuxHostEvidence | null;
  claimEpoch: number;
  claimOwner: string | null;
  pendingAction: "spawn" | "resume" | "handoff" | null;
  updatedAt: string;
}

export interface SpawnReceipt {
  launchId: string;
  /** Client-owned idempotency key. Legacy callers leave this null. */
  clientAttemptId: string | null;
  /** SHA-256 of the public launch shape. Prompt/image contents never persist. */
  requestDigest: string | null;
  /** Reserved at receipt birth so path discovery cannot choose the identity. */
  conversationId: ViewerConversationId;
  engine: AgentEngine;
  cwd: string;
  accountId: string | null;
  parentConversationId: ViewerConversationId | null;
  createdAt: string;
  state: "starting" | "pane-bound" | "host-verified" | "prompt-delivered" | "path-pending" | "completed" | "failed" | "conflicted";
  artifactPath: string | null;
  key: SessionKey | null;
  pane: TmuxSpawnBinding | null;
  verifiedHost: TmuxHostEvidence | null;
  target: string | null;
  completionMode: "route-completed" | "observed-completed" | "route-recovered" | null;
  error: string | null;
  launchProfile: LaunchProfile;
}

export interface SpawnLineageEdge {
  childConversationId: ViewerConversationId;
  parentConversationId: ViewerConversationId;
  childSessionKey: SessionKey | null;
  parentSessionKey: SessionKey | null;
  childArtifactPath: string | null;
  parentArtifactPath: string | null;
  source: "viewer-spawn";
  evidence: {
    launchId: string;
    clientAttemptId: string | null;
  };
  createdAt: string;
}

export interface SpawnRequest {
  engine: AgentEngine;
  cwd: string;
  launchProfile?: Partial<LaunchProfile>;
  clientAttemptId?: string | null;
  requestDigest?: string | null;
  accountId?: string | null;
  parentConversationId?: ViewerConversationId | null;
  parentSessionKey?: SessionKey | null;
  parentArtifactPath?: string | null;
}

export type SpawnBeginResult =
  | { kind: "created"; receipt: SpawnReceipt }
  | { kind: "replay"; receipt: SpawnReceipt }
  | { kind: "conflict"; receipt: SpawnReceipt };

export type SpawnSettlement =
  | { kind: "settled"; receipt: SpawnReceipt; entry: AgentRegistryEntry; conversation: RegistryConversation }
  | { kind: "conflict"; receipt: SpawnReceipt; code: "spawn_artifact_conflict" | "spawn_pane_conflict" | "spawn_identity_conflict" };

export interface RegistryConversation {
  id: ViewerConversationId;
  engine: Extract<AgentEngine, "claude" | "codex">;
  generations: NativeGeneration[];
  migration: ConversationMigration | null;
  turn: TurnState & { observedAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface RegistryFile {
  version: 2;
  entries: Record<string, AgentRegistryEntry>;
  receipts: Record<string, SpawnReceipt>;
  lineageEdges: Record<string, SpawnLineageEdge>;
  importedResumePanes: boolean;
  /** Compatibility evidence only. It never authorizes a pane until the live
      resolver proves server, process, engine, and transcript ownership. */
  legacyResumePanes: { serverPid: number | null; panes: Record<string, ResumePaneRecord> };
  conversations: Record<string, RegistryConversation>;
  conversationRevision: Record<Extract<AgentEngine, "claude" | "codex">, number>;
  migrationIntents: Record<string, MigrationIntent>;
  engineRouting: Record<Extract<AgentEngine, "claude" | "codex">, { activeAccountId: string | null; revision: number }>;
  autoBalance: Record<Extract<AgentEngine, "claude" | "codex">, AutoBalancePolicy>;
  quotaObservations: Record<Extract<AgentEngine, "claude" | "codex">, Record<string, DurableQuotaObservation>>;
  heldDeliveries: Record<string, HeldDelivery>;
}

type ConversationMigrationInput = Omit<ConversationMigration, "errorCode" | "operationId" | "sourceGenerationId" | "providerReceipt"> &
  Partial<Pick<ConversationMigration, "errorCode" | "operationId" | "sourceGenerationId" | "providerReceipt">>;
type SuccessorGenerationInput = Omit<NativeGeneration, "createdAt" | "archivedAt" | "launchProfile" | "historyHash" | "host"> &
  Partial<Pick<NativeGeneration, "launchProfile" | "historyHash" | "host">>;

export interface ConversationObservation {
  engine: Extract<AgentEngine, "claude" | "codex">;
  path: string;
  accountId: string | null;
  launchProfile: LaunchProfile;
  turn: TurnState;
  observedAt: string;
}

export class MigrationRevisionError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super("migration preview is stale");
    this.name = "MigrationRevisionError";
  }
}

function emptyPolicy(): AutoBalancePolicy {
  return {
    enabled: true,
    revision: 0,
    cooldownUntil: null,
    departed: {},
    lastOutcome: null,
    lastTrigger: null,
    lastCheckAt: null,
    sustain: null,
    restartedAt: now(),
  };
}

const EMPTY: RegistryFile = {
  version: 2,
  entries: {},
  receipts: {},
  lineageEdges: {},
  importedResumePanes: false,
  legacyResumePanes: { serverPid: null, panes: {} },
  conversations: {},
  conversationRevision: { claude: 0, codex: 0 },
  migrationIntents: {},
  engineRouting: { claude: { activeAccountId: null, revision: 0 }, codex: { activeAccountId: null, revision: 0 } },
  autoBalance: { claude: emptyPolicy(), codex: emptyPolicy() },
  quotaObservations: { claude: {}, codex: {} },
  heldDeliveries: {},
};

export class RegistryReadError extends Error {}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

function nativeGenerationId(pathname: string): string {
  return path.basename(pathname).match(/([0-9a-f-]{36})(?:\.jsonl)?$/i)?.[1] ?? crypto.randomUUID();
}

function normalizeGeneration(value: NativeGeneration): NativeGeneration {
  return {
    ...value,
    launchProfile: emptyLaunchProfile(value.launchProfile),
    historyHash: typeof value.historyHash === "string" ? value.historyHash : null,
    host: value.host && typeof value.host === "object" ? value.host : null,
  };
}

function normalizeConversation(value: RegistryConversation): RegistryConversation {
  const generations = Array.isArray(value.generations) ? value.generations.map(normalizeGeneration) : [];
  const current = generations.at(-1);
  const migration = value.migration && typeof value.migration === "object"
    ? {
      ...value.migration,
      errorCode: value.migration.errorCode ?? null,
      operationId: value.migration.operationId ?? `${value.migration.intentId}:${value.id}:${value.migration.revision}`,
      sourceGenerationId: value.migration.sourceGenerationId ?? current?.id ?? "",
      providerReceipt: value.migration.providerReceipt ?? null,
    }
    : null;
  return {
    ...value,
    generations,
    migration,
    turn: value.turn && typeof value.turn === "object"
      ? { state: value.turn.state, source: value.turn.source, terminalAt: value.turn.terminalAt ?? null, observedAt: value.turn.observedAt ?? null }
      : { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
  };
}

function normalizePolicy(value: AutoBalancePolicy | undefined): AutoBalancePolicy {
  const fallback = emptyPolicy();
  if (!value || typeof value !== "object") return fallback;
  return {
    ...fallback,
    ...value,
    departed: value.departed && typeof value.departed === "object" ? value.departed : {},
    lastOutcome: value.lastOutcome && typeof value.lastOutcome === "object" ? value.lastOutcome : null,
    sustain: value.sustain && typeof value.sustain === "object" ? value.sustain : null,
  };
}

function normalizeHeldDelivery(value: HeldDelivery): HeldDelivery {
  return {
    ...value,
    clientMessageId: value.clientMessageId ?? null,
    state: value.state ?? "held",
    generationId: value.generationId ?? null,
    attempts: Number.isInteger(value.attempts) ? value.attempts : 0,
    assignedAt: value.assignedAt ?? null,
    deliveredAt: value.deliveredAt ?? null,
    error: value.error ?? null,
  };
}

function normalizeReceipt(value: SpawnReceipt): SpawnReceipt {
  const state = value.state === "completed" || value.state === "failed" || value.state === "pane-bound" || value.state === "host-verified" || value.state === "prompt-delivered" || value.state === "path-pending" || value.state === "conflicted"
    ? value.state
    : "starting";
  const pane = value.pane && typeof value.pane === "object" && typeof value.pane.paneId === "string" && typeof value.pane.target === "string"
    ? { ...value.pane, display: typeof value.pane.display === "string" ? value.pane.display : value.pane.target, target: value.pane.paneId }
    : null;
  return {
    ...value,
    clientAttemptId: typeof value.clientAttemptId === "string" ? value.clientAttemptId : null,
    requestDigest: typeof value.requestDigest === "string" ? value.requestDigest : null,
    conversationId: typeof value.conversationId === "string" && value.conversationId.startsWith("conversation_")
      ? value.conversationId as ViewerConversationId
      : `conversation_${crypto.randomUUID()}`,
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    parentConversationId: typeof value.parentConversationId === "string" && value.parentConversationId.startsWith("conversation_")
      ? value.parentConversationId as ViewerConversationId
      : null,
    state,
    key: value.key && typeof value.key === "object" && (value.key.engine === "claude" || value.key.engine === "codex") && typeof value.key.sessionId === "string" ? value.key : null,
    pane,
    verifiedHost: value.verifiedHost && typeof value.verifiedHost === "object" && value.verifiedHost.kind === "tmux" ? value.verifiedHost : null,
    target: pane?.paneId ?? (typeof value.target === "string" && /^%\d+$/.test(value.target) ? value.target : null),
    completionMode: value.completionMode === "route-completed" || value.completionMode === "observed-completed" || value.completionMode === "route-recovered" ? value.completionMode : null,
    launchProfile: emptyLaunchProfile({ ...(value.launchProfile ?? {}), cwd: value.launchProfile?.cwd ?? value.cwd }),
  };
}

function upgradeV1(parsed: Omit<Partial<RegistryFile>, "version">): RegistryFile {
  const legacy = parsed.legacyResumePanes;
  return {
    ...clone(EMPTY),
    entries: (parsed.entries as RegistryFile["entries"]) ?? {},
    receipts: Object.fromEntries(Object.entries((parsed.receipts as RegistryFile["receipts"]) ?? {}).map(([id, receipt]) => [id, normalizeReceipt(receipt)])),
    importedResumePanes: parsed.importedResumePanes === true,
    legacyResumePanes: legacy && typeof legacy === "object" && "panes" in legacy
      ? { serverPid: typeof (legacy as { serverPid?: unknown }).serverPid === "number" ? (legacy as { serverPid: number }).serverPid : null, panes: ((legacy as { panes?: unknown }).panes as Record<string, ResumePaneRecord>) ?? {} }
      : { serverPid: null, panes: {} },
  };
}

function readFile(filename: string): RegistryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Omit<Partial<RegistryFile>, "version"> & { version?: unknown };
    if (parsed.version === 1 && parsed.entries && parsed.receipts && typeof parsed.entries === "object" && typeof parsed.receipts === "object") {
      return upgradeV1(parsed);
    }
    if (parsed.version !== 2 || !parsed.entries || !parsed.receipts || typeof parsed.entries !== "object" || typeof parsed.receipts !== "object") {
      throw new RegistryReadError("agent registry schema is unsupported");
    }
    const legacy = parsed.legacyResumePanes;
    return {
      version: 2,
      entries: parsed.entries,
      receipts: Object.fromEntries(Object.entries(parsed.receipts).map(([id, receipt]) => [id, normalizeReceipt(receipt)])),
      lineageEdges: parsed.lineageEdges && typeof parsed.lineageEdges === "object" ? parsed.lineageEdges : {},
      importedResumePanes: parsed.importedResumePanes === true,
      legacyResumePanes: legacy && typeof legacy === "object" && "panes" in legacy
        ? { serverPid: typeof (legacy as { serverPid?: unknown }).serverPid === "number" ? (legacy as { serverPid: number }).serverPid : null, panes: ((legacy as { panes?: unknown }).panes as Record<string, ResumePaneRecord>) ?? {} }
        : { serverPid: null, panes: {} },
      conversations: parsed.conversations && typeof parsed.conversations === "object"
        ? Object.fromEntries(Object.entries(parsed.conversations).map(([id, conversation]) => [id, normalizeConversation(conversation)]))
        : {},
      conversationRevision: parsed.conversationRevision && typeof parsed.conversationRevision === "object"
        ? { ...EMPTY.conversationRevision, ...parsed.conversationRevision }
        : clone(EMPTY.conversationRevision),
      migrationIntents: parsed.migrationIntents && typeof parsed.migrationIntents === "object" ? parsed.migrationIntents : {},
      engineRouting: parsed.engineRouting && typeof parsed.engineRouting === "object" ? { ...EMPTY.engineRouting, ...parsed.engineRouting } : clone(EMPTY.engineRouting),
      autoBalance: parsed.autoBalance && typeof parsed.autoBalance === "object"
        ? { claude: normalizePolicy(parsed.autoBalance.claude), codex: normalizePolicy(parsed.autoBalance.codex) }
        : { claude: emptyPolicy(), codex: emptyPolicy() },
      quotaObservations: parsed.quotaObservations && typeof parsed.quotaObservations === "object"
        ? { ...EMPTY.quotaObservations, ...parsed.quotaObservations }
        : clone(EMPTY.quotaObservations),
      heldDeliveries: parsed.heldDeliveries && typeof parsed.heldDeliveries === "object"
        ? Object.fromEntries(Object.entries(parsed.heldDeliveries).map(([id, delivery]) => [id, normalizeHeldDelivery(delivery)]))
        : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY);
    if (error instanceof RegistryReadError) throw error;
    throw new RegistryReadError(`agent registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeAtomic(filename: string, value: RegistryFile): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify(value, null, 2) + "\n";
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filename);
    const dir = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* rename completed */ }
  }
}

/** Durable source for identity and handoff evidence. The lock directory is
    intentionally separate from in-memory promises, so a Viewer replacement
    cannot leave an imaginary owner behind. */
export class AgentRegistry {
  constructor(
    readonly filename = statePath("agent-registry.json"),
    private readonly ownerAlive: (owner: ProcessIdentity) => boolean = (owner) =>
      procBackend.pidAlive(owner.pid) && (owner.startIdentity === null || procBackend.processIdentity(owner.pid) === owner.startIdentity),
  ) {}

  private acquireLock(lock: string, owner: ProcessIdentity): void {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        fs.mkdirSync(lock, 0o700);
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const previous = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) as ProcessIdentity;
          stale = Number.isInteger(previous.pid) && previous.pid > 0 && !this.ownerAlive(previous);
        } catch {
          /* A creator may still be writing owner.json. Preserve unknown locks. */
        }
        if (stale) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    throw new Error("agent registry is busy");
  }

  private mutate<T>(fn: (file: RegistryFile) => T): T {
    const lock = `${this.filename}.write-lock`;
    this.acquireLock(lock, { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) });
    try {
      const file = readFile(this.filename);
      const result = fn(file);
      writeAtomic(this.filename, file);
      return result;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  snapshot(): RegistryFile { return readFile(this.filename); }

  /** Create or replay a client-correlated durable launch receipt. Existing
      internal callers use beginSpawn() and receive an uncorrelated receipt. */
  beginSpawnRequest(input: SpawnRequest): SpawnBeginResult {
    return this.mutate((file) => {
      const profile = emptyLaunchProfile({ cwd: input.cwd, parentConversationId: input.parentConversationId ?? null, ...(input.launchProfile ?? {}) });
      if (input.clientAttemptId) {
        const existing = Object.values(file.receipts).find((receipt) => receipt.clientAttemptId === input.clientAttemptId);
        if (existing) {
          const compatible = existing.requestDigest === (input.requestDigest ?? null) && existing.engine === input.engine && existing.cwd === input.cwd;
          return { kind: compatible ? "replay" : "conflict", receipt: clone(existing) };
        }
      }
      const receipt: SpawnReceipt = {
        launchId: crypto.randomUUID(),
        clientAttemptId: input.clientAttemptId ?? null,
        requestDigest: input.requestDigest ?? null,
        conversationId: `conversation_${crypto.randomUUID()}`,
        engine: input.engine,
        cwd: input.cwd,
        accountId: input.accountId ?? null,
        parentConversationId: input.parentConversationId ?? null,
        createdAt: now(),
        state: "starting",
        artifactPath: null,
        key: null,
        pane: null,
        verifiedHost: null,
        target: null,
        completionMode: null,
        error: null,
        launchProfile: profile,
      };
      file.receipts[receipt.launchId] = receipt;
      if (receipt.parentConversationId) {
        file.lineageEdges[receipt.conversationId] = {
          childConversationId: receipt.conversationId,
          parentConversationId: receipt.parentConversationId,
          childSessionKey: null,
          parentSessionKey: input.parentSessionKey ?? null,
          childArtifactPath: null,
          parentArtifactPath: input.parentArtifactPath ?? null,
          source: "viewer-spawn",
          evidence: { launchId: receipt.launchId, clientAttemptId: receipt.clientAttemptId },
          createdAt: receipt.createdAt,
        };
      }
      return { kind: "created", receipt: clone(receipt) };
    });
  }

  beginSpawn(engine: AgentEngine, cwd: string, launchProfile: Partial<LaunchProfile> = {}): SpawnReceipt {
    const result = this.beginSpawnRequest({ engine, cwd, launchProfile });
    if (result.kind !== "created") throw new Error("could not create spawn receipt");
    return result.receipt;
  }

  bindSpawnPane(launchId: string, pane: TmuxSpawnBinding): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (receipt.pane && (receipt.pane.paneId !== pane.paneId || receipt.pane.server.startIdentity !== pane.server.startIdentity || receipt.pane.panePid.startIdentity !== pane.panePid.startIdentity)) {
        receipt.state = "conflicted";
        receipt.error = "spawn_pane_conflict";
        return clone(receipt);
      }
      if (receipt.state === "failed" || receipt.state === "conflicted") return clone(receipt);
      receipt.pane = { ...pane, display: pane.display ?? pane.target, target: pane.paneId };
      receipt.target = pane.paneId;
      if (receipt.state === "starting") receipt.state = "pane-bound";
      return clone(receipt);
    });
  }

  markSpawnHostVerified(launchId: string, host: TmuxHostEvidence): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (!receipt.pane ||
        receipt.pane.paneId !== host.paneId ||
        receipt.pane.server.pid !== host.server.pid ||
        receipt.pane.server.startIdentity !== host.server.startIdentity ||
        receipt.pane.panePid.pid !== host.panePid.pid ||
        receipt.pane.panePid.startIdentity !== host.panePid.startIdentity) {
        receipt.state = "conflicted";
        receipt.error = "spawn_host_identity_conflict";
        return clone(receipt);
      }
      if (receipt.state === "failed" || receipt.state === "conflicted") return clone(receipt);
      receipt.verifiedHost = host;
      receipt.target = host.paneId;
      if (receipt.state === "starting" || receipt.state === "pane-bound") receipt.state = "host-verified";
      return clone(receipt);
    });
  }

  markSpawnPromptDelivered(launchId: string): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (receipt.verifiedHost && (receipt.state === "host-verified" || receipt.state === "pane-bound" || receipt.state === "starting")) receipt.state = "prompt-delivered";
      return clone(receipt);
    });
  }

  markSpawnPathPending(launchId: string): SpawnReceipt {
    return this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt) throw new Error("unknown spawn receipt");
      if (receipt.verifiedHost && (receipt.state === "prompt-delivered" || receipt.state === "host-verified")) receipt.state = "path-pending";
      return clone(receipt);
    });
  }

  private settleSpawnInFile(file: RegistryFile, launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">, completionMode: NonNullable<SpawnReceipt["completionMode"]>): SpawnSettlement {
    const receipt = file.receipts[launchId];
    if (!receipt) throw new Error("unknown spawn receipt");
    const prior = receipt.key ? file.entries[sessionKeyId(receipt.key)] : null;
    const conflict = (code: "spawn_artifact_conflict" | "spawn_pane_conflict" | "spawn_identity_conflict"): SpawnSettlement => {
      receipt.state = "conflicted";
      receipt.error = code;
      return { kind: "conflict", receipt: clone(receipt), code };
    };
    if (receipt.engine !== entry.key.engine || receipt.cwd !== entry.cwd) return conflict("spawn_identity_conflict");
    if (receipt.pane && entry.host?.kind === "tmux" && (
      receipt.pane.paneId !== entry.host.paneId ||
      receipt.pane.server.pid !== entry.host.server.pid ||
      (receipt.pane.server.startIdentity !== null && entry.host.server.startIdentity !== receipt.pane.server.startIdentity) ||
      (receipt.pane.panePid.pid > 0 && receipt.pane.panePid.pid !== entry.host.panePid.pid) ||
      (receipt.pane.panePid.startIdentity !== null && entry.host.panePid.startIdentity !== receipt.pane.panePid.startIdentity)
    )) return conflict("spawn_pane_conflict");
    if (receipt.artifactPath && receipt.artifactPath !== entry.artifactPath) return conflict("spawn_artifact_conflict");
    if (receipt.key && sessionKeyId(receipt.key) !== sessionKeyId(entry.key)) return conflict("spawn_identity_conflict");
    const occupied = file.entries[sessionKeyId(entry.key)];
    if (occupied && occupied.artifactPath !== entry.artifactPath && (!prior || sessionKeyId(prior.key) !== sessionKeyId(entry.key))) return conflict("spawn_artifact_conflict");

    const existingConversation = file.conversations[receipt.conversationId];
    const createdAt = now();
    const conversation = existingConversation ?? {
      id: receipt.conversationId,
      engine: receipt.engine as Extract<AgentEngine, "claude" | "codex">,
      generations: [],
      migration: null,
      turn: { state: "unknown" as const, source: "empty" as const, terminalAt: null, observedAt: null },
      createdAt,
      updatedAt: createdAt,
    };
    if (conversation.engine !== receipt.engine) return conflict("spawn_identity_conflict");
    if (!conversation.generations.some((generation) => generation.path === entry.artifactPath)) {
      conversation.generations.push({
        id: nativeGenerationId(entry.artifactPath),
        path: entry.artifactPath,
        accountId: receipt.accountId,
        launchProfile: receipt.launchProfile,
        historyHash: null,
        host: null,
        createdAt,
        archivedAt: null,
      });
      file.conversationRevision[conversation.engine] += 1;
      file.engineRouting[conversation.engine].revision += 1;
    }
    /* A spawn that began before an account switch remains attributable to its
       birth account. The already-active migration intent still applies to the
       new conversation through the existing coordinator contract. */
    const activeIntent = Object.values(file.migrationIntents).find((intent) => intent.engine === conversation.engine && intent.state === "draining");
    const source = conversation.generations.at(-1);
    if (activeIntent && source && source.accountId !== activeIntent.targetId && !conversation.migration) {
      conversation.migration = {
        intentId: activeIntent.id,
        phase: conversation.turn.state === "busy" || conversation.turn.state === "unknown" ? "waiting-turn" : "requested",
        targetId: activeIntent.targetId,
        revision: activeIntent.revision,
        error: null,
        errorCode: null,
        operationId: crypto.randomUUID(),
        sourceGenerationId: source.id,
        providerReceipt: null,
        updatedAt: createdAt,
      };
    }
    conversation.updatedAt = createdAt;
    file.conversations[conversation.id] = conversation;

    const full: AgentRegistryEntry = {
      ...entry,
      accountId: receipt.accountId,
      launchProfile: receipt.launchProfile,
      updatedAt: createdAt,
    };
    file.entries[sessionKeyId(entry.key)] = full;
    receipt.key = entry.key;
    receipt.artifactPath = entry.artifactPath;
    const lineage = file.lineageEdges[receipt.conversationId];
    if (lineage) {
      lineage.childSessionKey = entry.key;
      lineage.childArtifactPath = entry.artifactPath;
    }
    if (entry.host?.kind === "tmux") receipt.verifiedHost = entry.host;
    if (receipt.target === null && entry.host?.kind === "tmux") receipt.target = entry.host.paneId;
    receipt.state = "completed";
    receipt.error = null;
    receipt.completionMode = receipt.completionMode === "observed-completed" && completionMode === "route-completed"
      ? "route-recovered"
      : receipt.completionMode ?? completionMode;
    return { kind: "settled", receipt: clone(receipt), entry: clone(full), conversation: clone(conversation) };
  }

  settleSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">, completionMode: NonNullable<SpawnReceipt["completionMode"]> = "route-completed"): SpawnSettlement {
    return this.mutate((file) => this.settleSpawnInFile(file, launchId, entry, completionMode));
  }

  completeSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    const outcome = this.settleSpawn(launchId, entry);
    if (outcome.kind === "conflict") throw new Error(outcome.code);
    return outcome.entry;
  }

  failSpawn(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted") return;
      receipt.state = receipt.pane ? "conflicted" : "failed";
      receipt.error = error;
      if (receipt.state === "conflicted") receipt.verifiedHost = null;
    });
  }

  invalidateSpawnHost(launchId: string, error: string): void {
    this.mutate((file) => {
      const receipt = file.receipts[launchId];
      if (!receipt || receipt.state === "failed" || receipt.state === "conflicted") return;
      receipt.state = "conflicted";
      receipt.error = error;
      receipt.verifiedHost = null;
    });
  }

  upsert(entry: Omit<AgentRegistryEntry, "updatedAt">): AgentRegistryEntry {
    return this.mutate((file) => {
      const full = { ...entry, updatedAt: now() };
      file.entries[sessionKeyId(entry.key)] = full;
      return clone(full);
    });
  }

  markUnhosted(key: SessionKey): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) return;
      entry.host = null;
      entry.status = "unhosted";
      entry.updatedAt = now();
    });
  }

  claim(key: SessionKey, owner: string): AgentRegistryEntry {
    return this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (!entry) throw new Error("agent registry entry is missing");
      if (entry.claimOwner && entry.claimOwner !== owner) throw new Error("agent session is claimed by another operation");
      entry.claimOwner = owner;
      entry.claimEpoch += 1;
      entry.updatedAt = now();
      return clone(entry);
    });
  }

  releaseClaim(key: SessionKey, owner: string): void {
    this.mutate((file) => {
      const entry = file.entries[sessionKeyId(key)];
      if (entry?.claimOwner === owner) {
        entry.claimOwner = null;
        entry.updatedAt = now();
      }
    });
  }

  /** Cross-process operation lock. Stale owners include their process start
      identity and may be recovered by an explicit caller after verification. */
  async withOperationLock<T>(key: SessionKey, owner: ProcessIdentity, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.filename}.locks/${encodeURIComponent(sessionKeyId(key))}`;
    this.acquireLock(lock, owner);
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  importResumePanes(serverPid: number, records: Map<string, ResumePaneRecord>): void {
    this.mutate((file) => {
      if (file.importedResumePanes && file.legacyResumePanes.serverPid === serverPid) return;
      file.legacyResumePanes = { serverPid, panes: Object.fromEntries(records) };
      file.importedResumePanes = true;
    });
  }

  resumePanes(serverPid: number): Map<string, ResumePaneRecord> {
    const saved = this.snapshot().legacyResumePanes;
    return saved.serverPid === serverPid ? new Map(Object.entries(saved.panes)) : new Map();
  }

  rememberResumePane(serverPid: number, pathname: string, record: ResumePaneRecord): void {
    this.mutate((file) => {
      if (file.legacyResumePanes.serverPid !== serverPid) file.legacyResumePanes = { serverPid, panes: {} };
      file.legacyResumePanes.panes[pathname] = record;
      file.importedResumePanes = true;
    });
  }

  reconcileSpawnReceipts(live: Iterable<SessionKey>): void {
    const liveIds = new Set([...live].map(sessionKeyId));
    this.mutate((file) => {
      for (const entry of Object.values(file.entries)) {
        if (liveIds.has(sessionKeyId(entry.key))) entry.pendingAction = null;
      }
      for (const receipt of Object.values(file.receipts)) {
        if (receipt.state !== "starting" || !receipt.artifactPath) continue;
        const key = Object.values(file.entries).find((entry) => entry.artifactPath === receipt.artifactPath)?.key;
        if (key && liveIds.has(sessionKeyId(key))) receipt.state = "completed";
      }
    });
  }

  /** Observation may enrich only the receipt named by the pane marker. Engine
      and cwd are validation evidence; they never select a launch receipt. */
  completeObservedSpawn(launchId: string, entry: Omit<AgentRegistryEntry, "updatedAt">): SpawnSettlement {
    return this.settleSpawn(launchId, entry, "observed-completed");
  }

  /** Allocates one Viewer-owned identity for every native generation. Paths
      remain an interoperability detail and can change on every account move. */
  ensureConversation(engine: Extract<AgentEngine, "claude" | "codex">, artifactPath: string, accountId: string | null): RegistryConversation {
    return this.mutate((file) => {
      const existing = Object.values(file.conversations).find((conversation) => conversation.engine === engine && conversation.generations.some((generation) => generation.path === artifactPath));
      if (existing) return clone(existing);
      const createdAt = now();
      const conversation: RegistryConversation = {
        id: `conversation_${crypto.randomUUID()}`,
        engine,
        generations: [{
          id: nativeGenerationId(artifactPath),
          path: artifactPath,
          accountId,
          launchProfile: emptyLaunchProfile(),
          historyHash: null,
          host: null,
          createdAt,
          archivedAt: null,
        }],
        migration: null,
        turn: { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
        createdAt,
        updatedAt: createdAt,
      };
      file.conversations[conversation.id] = conversation;
      file.conversationRevision[engine] += 1;
      file.engineRouting[engine].revision += 1;
      return clone(conversation);
    });
  }

  /** One inventory transaction owns identity allocation, launch-profile
      backfill, account provenance, and authoritative turn observations. */
  reconcileConversations(observations: ConversationObservation[]): RegistryFile {
    return this.mutate((file) => {
      const scopeChanged = new Set<Extract<AgentEngine, "claude" | "codex">>();
      for (const observation of observations) {
        let conversation = Object.values(file.conversations).find((candidate) =>
          candidate.engine === observation.engine && candidate.generations.some((generation) => generation.path === observation.path));
        if (!conversation) {
          const createdAt = observation.observedAt;
          conversation = {
            id: `conversation_${crypto.randomUUID()}`,
            engine: observation.engine,
            generations: [{
              id: nativeGenerationId(observation.path),
              path: observation.path,
              accountId: observation.accountId,
              launchProfile: emptyLaunchProfile(observation.launchProfile),
              historyHash: null,
              host: null,
              createdAt,
              archivedAt: null,
            }],
            migration: null,
            turn: { ...observation.turn, observedAt: observation.observedAt },
            createdAt,
            updatedAt: createdAt,
          };
          file.conversations[conversation.id] = conversation;
          scopeChanged.add(observation.engine);
          continue;
        }
        const generation = conversation.generations.find((candidate) => candidate.path === observation.path);
        if (!generation) continue;
        const priorAccountId = generation.accountId;
        const priorRole = generation.launchProfile.role;
        const priorTurnState = conversation.turn.state;
        generation.accountId = observation.accountId ?? generation.accountId;
        generation.launchProfile = {
          ...generation.launchProfile,
          ...observation.launchProfile,
          cwd: generation.launchProfile.cwd || observation.launchProfile.cwd,
          model: generation.launchProfile.model ?? observation.launchProfile.model,
          effort: generation.launchProfile.effort ?? observation.launchProfile.effort,
          fast: generation.launchProfile.fast ?? observation.launchProfile.fast,
          permissionMode: generation.launchProfile.permissionMode ?? observation.launchProfile.permissionMode,
          readOnly: generation.launchProfile.readOnly ?? observation.launchProfile.readOnly,
          title: generation.launchProfile.title ?? observation.launchProfile.title,
          project: generation.launchProfile.project ?? observation.launchProfile.project,
          parentConversationId: generation.launchProfile.parentConversationId ?? observation.launchProfile.parentConversationId,
          role: generation.launchProfile.role === "root" || observation.launchProfile.role === "root" ? "root" : "worker",
          goal: observation.launchProfile.goal ?? generation.launchProfile.goal,
          plan: observation.launchProfile.plan ?? generation.launchProfile.plan,
        };
        conversation.turn = { ...observation.turn, observedAt: observation.observedAt };
        conversation.updatedAt = observation.observedAt;
        if (priorAccountId !== generation.accountId || priorRole !== generation.launchProfile.role || priorTurnState !== conversation.turn.state) {
          scopeChanged.add(observation.engine);
        }
      }
      for (const engine of scopeChanged) {
        file.conversationRevision[engine] += 1;
        file.engineRouting[engine].revision += 1;
      }
      return clone(file);
    });
  }

  conversationForPath(artifactPath: string): RegistryConversation | null {
    return Object.values(this.snapshot().conversations).find((conversation) => conversation.generations.some((generation) => generation.path === artifactPath)) ?? null;
  }

  conversation(id: ViewerConversationId): RegistryConversation | null {
    return this.snapshot().conversations[id] ?? null;
  }

  launchProfileForPath(artifactPath: string): LaunchProfile | null {
    const snapshot = this.snapshot();
    const generation = Object.values(snapshot.conversations).flatMap((conversation) => conversation.generations).find((item) => item.path === artifactPath);
    if (generation) return clone(generation.launchProfile);
    const receipt = Object.values(snapshot.receipts).find((item) => item.artifactPath === artifactPath);
    return receipt ? clone(receipt.launchProfile) : null;
  }

  canonicalPath(artifactPath: string): string {
    const conversation = this.conversationForPath(artifactPath);
    return conversation?.generations.at(-1)?.path ?? artifactPath;
  }

  setEngineRouting(engine: Extract<AgentEngine, "claude" | "codex">, accountId: string): number {
    return this.mutate((file) => {
      const route = file.engineRouting[engine];
      route.activeAccountId = accountId;
      route.revision += 1;
      return route.revision;
    });
  }

  engineRouting(engine: Extract<AgentEngine, "claude" | "codex">): { activeAccountId: string | null; revision: number } {
    return clone(this.snapshot().engineRouting[engine]);
  }

  retireAccount(engine: Extract<AgentEngine, "claude" | "codex">, accountId: string, fallbackAccountId: string): void {
    this.mutate((file) => {
      const changedAt = now();
      const route = file.engineRouting[engine];
      if (route.activeAccountId === accountId) {
        route.activeAccountId = fallbackAccountId;
        route.revision += 1;
      }
      const retiredIntentIds = new Set<string>();
      for (const intent of Object.values(file.migrationIntents)) {
        if (intent.engine !== engine || intent.targetId !== accountId) continue;
        retiredIntentIds.add(intent.id);
        if (intent.state === "stopped") continue;
        intent.state = "stopped";
        intent.revision += 1;
        intent.updatedAt = changedAt;
        intent.stoppedAt = changedAt;
      }
      if (retiredIntentIds.size === 0) return;
      for (const conversation of Object.values(file.conversations)) {
        if (!conversation.migration || !retiredIntentIds.has(conversation.migration.intentId)) continue;
        conversation.migration = null;
        conversation.updatedAt = changedAt;
        file.conversationRevision[conversation.engine] += 1;
      }
    });
  }

  commitMigrationIntent(input: {
    engine: Extract<AgentEngine, "claude" | "codex">;
    targetId: string;
    origin: MigrationOrigin;
    requestId: string;
    expectedRevision: number;
    evidence?: MigrationIntent["evidence"];
  }): MigrationIntent {
    return this.mutate((file) => {
      const repeated = Object.values(file.migrationIntents).find((intent) =>
        intent.engine === input.engine && intent.requestIds.includes(input.requestId));
      if (repeated) return clone(repeated);
      const route = file.engineRouting[input.engine];
      if (route.revision !== input.expectedRevision) throw new MigrationRevisionError(input.expectedRevision, route.revision);
      let intent = Object.values(file.migrationIntents).find((candidate) => candidate.engine === input.engine && candidate.state === "draining");
      if (intent?.origin === "manual" && input.origin === "auto") return clone(intent);
      const changedAt = now();
      if (intent) {
        intent.requestIds.push(input.requestId);
        intent.targetId = input.targetId;
        intent.origin = input.origin;
        intent.revision += 1;
        intent.evidence = input.evidence ?? null;
        intent.updatedAt = changedAt;
      } else {
        intent = {
          id: crypto.randomUUID(),
          engine: input.engine,
          targetId: input.targetId,
          origin: input.origin,
          revision: 1,
          state: "draining",
          createdAt: changedAt,
          updatedAt: changedAt,
          requestIds: [input.requestId],
          evidence: input.evidence ?? null,
          stoppedAt: null,
        };
        file.migrationIntents[intent.id] = intent;
      }
      route.activeAccountId = input.targetId;
      route.revision += 1;

      let scoped = 0;
      for (const conversation of Object.values(file.conversations)) {
        if (conversation.engine !== input.engine) continue;
        const source = conversation.generations.at(-1);
        if (!source || source.accountId === null || source.accountId === input.targetId) {
          if (conversation.migration && conversation.migration.phase !== "committed") conversation.migration = null;
          continue;
        }
        scoped += 1;
        conversation.migration = {
          intentId: intent.id,
          phase: conversation.turn.state === "busy" || conversation.turn.state === "unknown" ? "waiting-turn" : "requested",
          targetId: input.targetId,
          revision: intent.revision,
          error: null,
          errorCode: null,
          operationId: crypto.randomUUID(),
          sourceGenerationId: source.id,
          providerReceipt: null,
          updatedAt: changedAt,
        };
        conversation.updatedAt = changedAt;
      }
      if (scoped === 0) intent.state = "complete";
      return clone(intent);
    });
  }

  upsertMigrationIntent(engine: Extract<AgentEngine, "claude" | "codex">, targetId: string, origin: MigrationOrigin, requestId: string, evidence: MigrationIntent["evidence"] = null): MigrationIntent {
    return this.mutate((file) => {
      const active = Object.values(file.migrationIntents).find((intent) => intent.engine === engine && intent.state === "draining");
      if (active) {
        if (active.origin === "manual" && origin === "auto") return clone(active);
        if (!active.requestIds.includes(requestId)) active.requestIds.push(requestId);
        if (active.targetId !== targetId || active.origin !== origin) { active.targetId = targetId; active.origin = origin; active.revision += 1; active.evidence = evidence; }
        active.updatedAt = now();
        return clone(active);
      }
      const createdAt = now();
      const intent: MigrationIntent = { id: crypto.randomUUID(), engine, targetId, origin, revision: 1, state: "draining", createdAt, updatedAt: createdAt, requestIds: [requestId], evidence, stoppedAt: null };
      file.migrationIntents[intent.id] = intent;
      return clone(intent);
    });
  }

  setConversationMigration(id: ViewerConversationId, migration: ConversationMigrationInput | null): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      if (!conversation) throw new Error("viewer conversation is unknown");
      const source = conversation.generations.at(-1);
      conversation.migration = migration ? {
        ...migration,
        errorCode: migration.errorCode ?? null,
        operationId: migration.operationId ?? `${migration.intentId}:${id}:${migration.revision}`,
        sourceGenerationId: migration.sourceGenerationId ?? source?.id ?? "",
        providerReceipt: migration.providerReceipt ?? null,
      } : null;
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  transitionConversationMigration(
    id: ViewerConversationId,
    expectedRevision: number,
    expectedPhases: ConversationMigration["phase"][],
    patch: Partial<Pick<ConversationMigration, "phase" | "error" | "errorCode" | "providerReceipt" | "targetId" | "revision">>,
  ): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      const migration = conversation?.migration;
      if (!conversation || !migration) throw new Error("conversation has no migration");
      if (migration.revision !== expectedRevision || !expectedPhases.includes(migration.phase)) throw new Error("migration transition is stale");
      conversation.migration = { ...migration, ...patch, updatedAt: now() };
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  retryConversationMigration(id: ViewerConversationId, expectedRevision?: number): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      const current = conversation?.migration;
      if (!conversation || !current) throw new Error("conversation has no migration");
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("migration revision is stale");
      const intent = file.migrationIntents[current.intentId];
      if (!intent || intent.state === "stopped") throw new Error("migration intent is inactive");
      if (intent.state === "complete" && current.phase === "failed-recoverable") {
        intent.state = "draining";
        intent.updatedAt = now();
      }
      const source = conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
      conversation.migration = {
        ...current,
        phase: conversation.turn.state === "busy" || conversation.turn.state === "unknown" ? "waiting-turn" : "requested",
        targetId: intent.targetId,
        revision: intent.revision,
        operationId: crypto.randomUUID(),
        sourceGenerationId: source.id,
        providerReceipt: null,
        error: null,
        errorCode: null,
        updatedAt: now(),
      };
      conversation.updatedAt = now();
      return clone(conversation);
    });
  }

  commitSuccessor(id: ViewerConversationId, successor: SuccessorGenerationInput, expectedRevision: number): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      if (!conversation?.migration || conversation.migration.revision !== expectedRevision) throw new Error("migration revision is stale");
      if (conversation.migration.phase === "committed") {
        const current = conversation.generations.at(-1);
        if (current?.id === successor.id && current.path === successor.path) return clone(conversation);
        throw new Error("migration succession is already committed");
      }
      if (conversation.migration.phase !== "verifying") throw new Error("migration succession is not ready to commit");
      const predecessor = conversation.generations.at(-1);
      if (!predecessor) throw new Error("viewer conversation has no native generation");
      const committedAt = now();
      predecessor.archivedAt = committedAt;
      const generation: NativeGeneration = {
        ...successor,
        launchProfile: emptyLaunchProfile(successor.launchProfile ?? predecessor.launchProfile),
        historyHash: successor.historyHash ?? null,
        host: successor.host ?? null,
        createdAt: committedAt,
        archivedAt: null,
      };
      conversation.generations.push(generation);
      conversation.migration = { ...conversation.migration, phase: "committed", updatedAt: now() };
      conversation.updatedAt = now();
      for (const delivery of Object.values(file.heldDeliveries)) {
        if (delivery.conversationId !== id || delivery.state !== "held") continue;
        delivery.state = "assigned";
        delivery.generationId = generation.id;
        delivery.assignedAt = committedAt;
        delivery.error = null;
      }
      return clone(conversation);
    });
  }

  setMigrationIntentState(id: string, state: MigrationIntent["state"], expectedRevision?: number): MigrationIntent {
    return this.mutate((file) => {
      const intent = file.migrationIntents[id];
      if (!intent) throw new Error("migration intent is unknown");
      if (expectedRevision !== undefined && intent.revision !== expectedRevision) throw new Error("migration intent revision is stale");
      intent.state = state;
      intent.stoppedAt = state === "stopped" ? now() : intent.stoppedAt;
      intent.updatedAt = now();
      if (state === "stopped") {
        for (const conversation of Object.values(file.conversations)) {
          if (conversation.migration?.intentId !== id || conversation.migration.phase === "committed") continue;
          const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
            ?? conversation.generations.at(-1);
          if (!source) continue;
          conversation.migration = { ...conversation.migration, phase: "rolled-back", error: null, errorCode: null, updatedAt: intent.updatedAt };
          for (const delivery of Object.values(file.heldDeliveries)) {
            if (delivery.conversationId !== conversation.id || delivery.state === "delivered" || delivery.state === "delivery-uncertain") continue;
            delivery.state = "assigned";
            delivery.generationId = source.id;
            delivery.assignedAt = intent.updatedAt;
            delivery.error = null;
          }
        }
      }
      return clone(intent);
    });
  }

  autoBalancePolicy(engine: Extract<AgentEngine, "claude" | "codex">): AutoBalancePolicy {
    return clone(this.snapshot().autoBalance[engine]);
  }

  quotaObservations(engine: Extract<AgentEngine, "claude" | "codex">): DurableQuotaObservation[] {
    return clone(Object.values(this.snapshot().quotaObservations[engine]));
  }

  recordQuotaEvaluation(input: {
    engine: Extract<AgentEngine, "claude" | "codex">;
    observations: DurableQuotaObservation[];
    signature: string | null;
    evidence?: MigrationIntent["evidence"];
    bootId: string;
    now: string;
    minimumGapMs: number;
  }): { sustained: boolean; routeRevision: number; policy: AutoBalancePolicy } {
    return this.mutate((file) => {
      for (const observation of input.observations) {
        if (observation.engine === input.engine) file.quotaObservations[input.engine][observation.accountId] = observation;
      }
      const policy = file.autoBalance[input.engine];
      policy.lastCheckAt = input.now;
      let sustained = false;
      if (!input.signature) {
        policy.sustain = null;
      } else if (!policy.sustain || policy.sustain.signature !== input.signature || policy.sustain.bootId !== input.bootId) {
        policy.sustain = { signature: input.signature, firstAt: input.now, lastAt: input.now, bootId: input.bootId };
      } else {
        const firstAt = Date.parse(policy.sustain.firstAt);
        policy.sustain.lastAt = input.now;
        sustained = Number.isFinite(firstAt) && Date.parse(input.now) - firstAt >= input.minimumGapMs;
        if (sustained) {
          policy.sustain = null;
          policy.lastTrigger = input.evidence ?? null;
        }
      }
      policy.revision += 1;
      return { sustained, routeRevision: file.engineRouting[input.engine].revision, policy: clone(policy) };
    });
  }

  setAutoBalancePolicy(engine: Extract<AgentEngine, "claude" | "codex">, enabled: boolean, expectedRevision?: number): AutoBalancePolicy {
    return this.mutate((file) => {
      const policy = file.autoBalance[engine];
      if (expectedRevision !== undefined && policy.revision !== expectedRevision) throw new Error("automatic balance policy revision is stale");
      policy.enabled = enabled;
      if (!enabled) policy.sustain = null;
      policy.revision += 1;
      return clone(policy);
    });
  }

  recordAutoBalanceOutcome(
    engine: Extract<AgentEngine, "claude" | "codex">,
    outcome: "complete" | "stopped" | "failed-partial",
    evidence: AutoBalancePolicy["lastTrigger"],
    cooldownUntil: string,
  ): AutoBalancePolicy {
    return this.mutate((file) => {
      const policy = file.autoBalance[engine];
      policy.cooldownUntil = cooldownUntil;
      policy.lastOutcome = {
        at: now(),
        kind: outcome === "complete" ? "switched" : outcome === "failed-partial" ? "failed" : "skipped",
        fromId: evidence?.sourceId ?? null,
        fromPercent: evidence?.sourcePercent ?? null,
        toId: evidence?.targetId ?? null,
        toPercent: evidence?.targetPercent ?? null,
        window: evidence?.sourceWindow ?? null,
        detail: outcome === "failed-partial" ? "one or more sessions need operator recovery" : null,
      };
      policy.lastTrigger = evidence;
      if (evidence) policy.departed[evidence.sourceId] = now();
      policy.revision += 1;
      return clone(policy);
    });
  }

  holdDelivery(conversationId: ViewerConversationId, text: string, clientMessageId: string | null = null): HeldDelivery {
    if (!text || text.length > 32_000) throw new Error("held delivery must contain at most 32000 characters");
    return this.mutate((file) => {
      const existing = clientMessageId ? Object.values(file.heldDeliveries).find((item) => item.conversationId === conversationId && item.clientMessageId === clientMessageId) : undefined;
      if (existing) return clone(existing);
      const held: HeldDelivery = {
        id: crypto.randomUUID(),
        conversationId,
        text,
        createdAt: now(),
        clientMessageId,
        state: "held",
        generationId: null,
        attempts: 0,
        assignedAt: null,
        deliveredAt: null,
        error: null,
      };
      const count = Object.values(file.heldDeliveries).filter((item) => item.conversationId === conversationId && item.state !== "delivered").length;
      if (count >= 100) throw new Error("held delivery limit reached for conversation");
      file.heldDeliveries[held.id] = held;
      return clone(held);
    });
  }

  pendingDeliveries(conversationId: ViewerConversationId): HeldDelivery[] {
    return Object.values(this.snapshot().heldDeliveries)
      .filter((item) => item.conversationId === conversationId && item.state !== "delivered")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  beginDeliveryAttempt(id: string, generationId: string): HeldDelivery | null {
    return this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      if (!delivery || delivery.state !== "assigned" || delivery.generationId !== generationId) return null;
      delivery.state = "delivery-uncertain";
      delivery.attempts += 1;
      delivery.error = "delivery started; recovery requires an explicit outcome";
      return clone(delivery);
    });
  }

  recordDeliveryOutcome(
    id: string,
    state: Extract<HeldDelivery["state"], "delivered" | "failed" | "delivery-uncertain">,
    error: string | null = null,
  ): HeldDelivery {
    return this.mutate((file) => {
      const delivery = file.heldDeliveries[id];
      if (!delivery) throw new Error("held delivery is unknown");
      if (delivery.state === "delivered") return clone(delivery);
      delivery.state = state;
      delivery.deliveredAt = state === "delivered" ? now() : null;
      delivery.error = error?.slice(0, 240) ?? null;
      return clone(delivery);
    });
  }

  rollbackConversationMigration(id: ViewerConversationId, expectedRevision?: number): RegistryConversation {
    return this.mutate((file) => {
      const conversation = file.conversations[id];
      if (!conversation?.migration) throw new Error("conversation has no migration");
      if (expectedRevision !== undefined && conversation.migration.revision !== expectedRevision) throw new Error("migration revision is stale");
      const source = conversation.generations.find((generation) => generation.id === conversation.migration?.sourceGenerationId)
        ?? conversation.generations.at(-1);
      if (!source) throw new Error("conversation has no source generation");
      const rolledAt = now();
      for (const delivery of Object.values(file.heldDeliveries)) {
        if (delivery.conversationId !== id || delivery.state === "delivered" || delivery.state === "delivery-uncertain") continue;
        delivery.state = "assigned";
        delivery.generationId = source.id;
        delivery.assignedAt = rolledAt;
        delivery.error = null;
      }
      conversation.migration = { ...conversation.migration, phase: "rolled-back", error: null, errorCode: null, updatedAt: rolledAt };
      conversation.updatedAt = rolledAt;
      return clone(conversation);
    });
  }
}

let registry: AgentRegistry | null = null;
export function agentRegistry(): AgentRegistry {
  registry ??= new AgentRegistry();
  return registry;
}

export function setAgentRegistryForTests(value: AgentRegistry | null): void {
  registry = value;
}
