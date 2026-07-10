import type { RoleConfig } from "@/lib/flows/types";

// Shared contract for agent workflows (docs/design/agent-workflows.md).
// This file is the seam between the server engine (src/lib/workflows/*) and
// the UI (src/components/*). Extend it only when the spec changes.

export type WorkflowStageKind = "implement" | "review-loop";

export type ImplementStage = {
  kind: "implement";
  agent: RoleConfig; // engine/model/effort, e.g. claude "fable"
  scope: string; // role brief: "UI/frontend", "backend/API"
};

export type ReviewStage = {
  kind: "review-loop";
  reviewer: RoleConfig;
  fixer: RoleConfig; // default {engine:"codex", model:"gpt-5.6-terra", effort:"low"} (W5)
  roundLimit: number; // default 5
  reviewerMode: "headless" | "pane"; // default "headless"
};

export type WorkflowStage = ImplementStage | ReviewStage;

export type FinishAction = "pr" | "merge";

export type WorkflowTemplate = {
  name: string;
  stages: WorkflowStage[]; // implement+, then one review-loop last (W1)
  finish: FinishAction; // default "pr" (W7)
  setup?: string; // e.g. "bun install", runs in the worktree before stage 0
  verify?: string; // hint for stage kickoffs, e.g. "bun test && bun run build"
};

export type WorkflowState =
  | "provisioning"
  | "implementing"
  | "reviewing"
  | "finishing"
  | "approved"
  | "needs_decision"
  | "paused"
  | "closed";

export type WorkflowStageRun = {
  index: number;
  agentPath: string | null; // transcript once known
  agentConversationId?: string | null;
  paneId: string | null;
  startedAt: string | null;
  doneAt: string | null;
  doneNote: string | null; // text after STAGE_DONE:
  accountId?: string | null;
};

export type Workflow = {
  id: string; // short uuid slice, like flows
  name: string; // template name or "ad-hoc"
  task: string; // user's brief
  /** Scanner project key of repoDir, stamped at creation: the dashboard
      group where the strip renders before any agent transcript exists. */
  project: string;
  repoDir: string;
  worktreeDir: string;
  branch: string; // wf/<slug>
  baseBranch: string; // repoDir's branch at provisioning (merge/PR target)
  baseRef: string; // sha at branch start; "" until provisioning captures it
  template: WorkflowTemplate; // frozen copy at launch (W8)
  stageRuns: WorkflowStageRun[];
  stageIndex: number;
  flowId: string | null; // embedded review Flow (W9)
  fixerPath: string | null;
  fixerConversationId?: string | null;
  state: WorkflowState;
  /** The state to return to on resume/retry; set for paused and needs_decision. */
  pausedState: WorkflowState | null;
  stateDetail: string | null;
  mode: "auto" | "manual";
  /** OS pid of the detached setup command, persisted across restarts. */
  setupPid?: number | null;
  /** Transcript of the conversation that launched the workflow, when known;
      stage 0 gets linked under it as a handoff branch. */
  srcPath?: string | null;
  srcConversationId?: string | null;
  prUrl: string | null; // finish=pr result
  createdAt: string;
  closedAt: string | null;
};

export type WorkflowAction = "pause" | "resume" | "advance" | "retry-stage" | "close";

export type CreateWorkflowRequest = {
  /** Template name from workflow-templates.json; mutually exclusive with `stages`. */
  template?: string;
  /** Ad-hoc pipeline instead of a named template. */
  stages?: WorkflowStage[];
  finish?: FinishAction;
  setup?: string;
  verify?: string;
  task: string;
  repoDir: string;
  mode?: "auto" | "manual";
  /** Transcript of the conversation that launched the workflow, for lineage. */
  src?: string;
};

export type PatchWorkflowRequest = {
  action: WorkflowAction;
  /** for advance: the note recorded as the forced stage's done note */
  note?: string;
};

export type WorkflowsResponse = {
  workflows: Workflow[];
  templates: WorkflowTemplate[];
};
