import type { AgentEngine } from "@/lib/agent/cli";
import type { StructuredImageRef } from "@/lib/runtime/structuredContent";
import type { AgentGoal, AgentPlan, EngineLimits, LimitsProvenance } from "@/lib/types";

export type MigrationEngine = Extract<AgentEngine, "claude" | "codex">;
export type ViewerConversationId = `conversation_${string}`;
export type MigrationOrigin = "manual" | "auto";
export type MigrationPhase = "requested" | "waiting-turn" | "preparing" | "successor-starting" | "verifying" | "committed" | "failed-recoverable" | "rolled-back";
export type MigrationIntentState = "draining" | "complete" | "stopped";

export interface LaunchProfile {
  cwd: string;
  model: string | null;
  effort: string | null;
  fast: boolean | null;
  permissionMode: string | null;
  readOnly: boolean | null;
  allowSubagents: boolean;
  title: string | null;
  project: string | null;
  parentConversationId: ViewerConversationId | null;
  role: "root" | "worker";
  goal: AgentGoal | null;
  plan: AgentPlan | null;
}

export function emptyLaunchProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    cwd: "",
    model: null,
    effort: null,
    fast: null,
    permissionMode: null,
    readOnly: null,
    allowSubagents: false,
    title: null,
    project: null,
    parentConversationId: null,
    role: "worker",
    goal: null,
    plan: null,
    ...overrides,
  };
}

export interface GenerationHostEvidence {
  kind: "tmux" | "codex-app-server" | "claude-stream";
  identity: string;
  epoch: number;
  verifiedAt: string;
  tmuxHost?: {
    kind: "tmux";
    endpoint: string;
    server: { pid: number; startIdentity: string | null };
    paneId: string;
    panePid: { pid: number; startIdentity: string | null };
    windowName: string;
    agent: { pid: number; startIdentity: string | null };
    argv: string[];
  };
}

export interface NativeGeneration {
  id: string;
  path: string;
  accountId: string | null;
  launchProfile: LaunchProfile;
  historyHash: string | null;
  host: GenerationHostEvidence | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface ConversationMigration {
  intentId: string;
  phase: MigrationPhase;
  targetId: string;
  revision: number;
  error: string | null;
  errorCode: string | null;
  operationId: string;
  sourceGenerationId: string;
  providerReceipt: ProviderReceipt | null;
  /** Continuity artifacts created by the active succession and awaiting commit. */
  pendingContinuityPaths: string[];
  /** Canonical board project whose path aliases have converged for this generation. */
  boardProject: string | null;
  /** Migration operation whose aliases have converged in boardProject. */
  boardOperationId: string | null;
  /** Project currently holding this conversation's durable placement. */
  boardPlacementProject: string | null;
  updatedAt: string;
}

export interface ProviderReceipt {
  operationId: string;
  nativeId: string;
  path: string;
  /** Provider-created artifacts that retain the conversation identity throughout migration. */
  continuityPaths: string[];
  historyHash: string;
  host: GenerationHostEvidence;
}

function sameProcessIdentity(
  left: { pid: number; startIdentity: string | null },
  right: { pid: number; startIdentity: string | null },
): boolean {
  return left.pid === right.pid && left.startIdentity === right.startIdentity;
}

export function sameGenerationHostEvidence(left: GenerationHostEvidence, right: GenerationHostEvidence): boolean {
  if (left.kind !== right.kind || left.identity !== right.identity || left.epoch !== right.epoch) return false;
  const leftTmux = left.tmuxHost;
  const rightTmux = right.tmuxHost;
  if (!leftTmux || !rightTmux) return leftTmux === rightTmux;
  return leftTmux.kind === rightTmux.kind
    && leftTmux.endpoint === rightTmux.endpoint
    && sameProcessIdentity(leftTmux.server, rightTmux.server)
    && leftTmux.paneId === rightTmux.paneId
    && sameProcessIdentity(leftTmux.panePid, rightTmux.panePid)
    && leftTmux.windowName === rightTmux.windowName
    && sameProcessIdentity(leftTmux.agent, rightTmux.agent)
    && leftTmux.argv.length === rightTmux.argv.length
    && leftTmux.argv.every((argument, index) => argument === rightTmux.argv[index]);
}

export function sameProviderReceiptOutcome(left: ProviderReceipt, right: ProviderReceipt): boolean {
  return left.operationId === right.operationId
    && left.nativeId === right.nativeId
    && left.path === right.path
    && left.historyHash === right.historyHash
    && left.continuityPaths.length === right.continuityPaths.length
    && left.continuityPaths.every((pathname, index) => pathname === right.continuityPaths[index])
    && sameGenerationHostEvidence(left.host, right.host);
}

export interface MigrationEvidence {
  sourceId: string;
  sourcePercent: number;
  sourceWindow: "session" | "weekly";
  targetId: string;
  targetPercent: number;
  targetWindow: "session" | "weekly";
  observedAt: string;
}

export interface MigrationIntent {
  id: string;
  engine: MigrationEngine;
  targetId: string;
  origin: MigrationOrigin;
  revision: number;
  state: MigrationIntentState;
  createdAt: string;
  updatedAt: string;
  requestIds: string[];
  evidence: MigrationEvidence | null;
  stoppedAt: string | null;
}

export interface AutoBalancePolicy {
  enabled: boolean;
  revision: number;
  cooldownUntil: string | null;
  departed: Record<string, string>;
  lastOutcome: {
    at: string;
    kind: "switched" | "failed" | "skipped";
    fromId: string | null;
    fromPercent: number | null;
    toId: string | null;
    toPercent: number | null;
    window: "session" | "weekly" | null;
    detail: string | null;
  } | null;
  lastTrigger: MigrationEvidence | null;
  lastCheckAt: string | null;
  sustain: { signature: string; firstAt: string; lastAt: string; bootId: string } | null;
  restartedAt: string;
}

export interface TurnState {
  state: "busy" | "terminal" | "idle" | "unknown";
  source: "lifecycle" | "tool" | "assistant" | "empty";
  terminalAt: string | null;
}

export interface DurableQuotaObservation {
  engine: MigrationEngine;
  accountId: string;
  authenticated: boolean;
  authCheckedAt: string;
  limits: EngineLimits | null;
  provenance: LimitsProvenance;
  observedAt: string;
  bootId: string;
}

export interface HeldDeliveryCommand {
  operationId: string;
  kind: "send" | "steer";
  policy: "queue" | "steer-if-active" | "interrupt-active";
  turnId?: string | null;
}

export interface HeldDeliveryCommandInput {
  operationId?: string;
  kind?: HeldDeliveryCommand["kind"];
  policy?: HeldDeliveryCommand["policy"];
  turnId?: string | null;
}

export interface HeldDelivery {
  id: string;
  conversationId: ViewerConversationId;
  text: string;
  createdAt: string;
  clientMessageId: string | null;
  /** Image payload bytes stay request-local; these reservations can only be retried by the client. */
  payloadKind: "text" | "ephemeral-images" | "ephemeral-text" | "runtime-images";
  runtimeImages: StructuredImageRef[];
  contentDigest: string | null;
  /** Inbox files already materialized for an ambiguous request-local attempt. */
  artifactPaths: string[];
  command: HeldDeliveryCommand;
  requestDigest: string | null;
  state: "held" | "assigned" | "delivered" | "failed" | "delivery-uncertain";
  generationId: string | null;
  attempts: number;
  assignedAt: string | null;
  deliveredAt: string | null;
  error: string | null;
}

export interface SuccessorProviderPort {
  /** Allows controlled fixtures and legacy adapters to supply a source without a filesystem transcript. */
  virtualSource?: true;
  create(input: {
    engine: MigrationEngine;
    operationId: string;
    conversationId: ViewerConversationId;
    source: NativeGeneration;
    targetAccountId: string;
    /** Persists a provider-created artifact after its path and file identity are validated. */
    recordContinuityPath(pathname: string): void;
  }): Promise<ProviderReceipt>;
  verify(receipt: ProviderReceipt, input: { engine: MigrationEngine; targetAccountId: string; launchProfile: LaunchProfile }): Promise<void>;
  publishHost?(receipt: ProviderReceipt, input: {
    engine: MigrationEngine;
    conversationId: ViewerConversationId;
    targetAccountId: string;
    launchProfile: LaunchProfile;
  }): Promise<void>;
  cleanup?(receipt: ProviderReceipt): Promise<void>;
}

/** Transitional copy-only fake supported by the legacy coordinator wrapper. */
export interface HistoryCopyPort {
  copy(input: { engine: MigrationEngine; sourcePath: string; targetHome: string; conversationId: ViewerConversationId }): Promise<{ nativeId: string; path: string }>;
}
