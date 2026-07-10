import type { AgentEngine } from "@/lib/agent/cli";
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
  updatedAt: string;
}

export interface ProviderReceipt {
  operationId: string;
  nativeId: string;
  path: string;
  historyHash: string;
  host: GenerationHostEvidence;
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

export interface HeldDelivery {
  id: string;
  conversationId: ViewerConversationId;
  text: string;
  createdAt: string;
  clientMessageId: string | null;
  state: "held" | "assigned" | "delivered" | "failed" | "delivery-uncertain";
  generationId: string | null;
  attempts: number;
  assignedAt: string | null;
  deliveredAt: string | null;
  error: string | null;
}

export interface SuccessorProviderPort {
  create(input: {
    engine: MigrationEngine;
    operationId: string;
    conversationId: ViewerConversationId;
    source: NativeGeneration;
    targetAccountId: string;
  }): Promise<ProviderReceipt>;
  verify(receipt: ProviderReceipt, input: { engine: MigrationEngine; targetAccountId: string; launchProfile: LaunchProfile }): Promise<void>;
}

/** Transitional copy-only fake supported by the legacy coordinator wrapper. */
export interface HistoryCopyPort {
  copy(input: { engine: MigrationEngine; sourcePath: string; targetHome: string; conversationId: ViewerConversationId }): Promise<{ nativeId: string; path: string }>;
}

/** Native cross-home copying is deliberately gated. Production enables a
    provider port only after an explicit authentication preflight succeeds. */
export class DisabledSuccessorProviderPort implements SuccessorProviderPort {
  async create(): Promise<ProviderReceipt> {
    throw new Error("account migration activation requires an explicit operator preflight");
  }
  async verify(): Promise<void> {
    throw new Error("account migration activation requires an explicit operator preflight");
  }
}

/** Compatibility name retained for older imports while provider callers move
    to the full successor contract. */
export class DisabledHistoryCopyPort extends DisabledSuccessorProviderPort {}
