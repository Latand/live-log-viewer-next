/**
 * Synthetic board seeds for the issue #962 depth-ladder evidence run. All data
 * is generated at runtime into the DISPOSABLE demo capture home — nothing here
 * touches the operator's viewer state and no identities land in sources.
 *
 * Seeded surfaces:
 *  - a PARKED (needs_decision) two-stage pipeline over two existing beacon
 *    conversations — renders the settled pipeline region as a filled well;
 *  - a DRAFT pipeline in the same project — renders the dashed draft halo,
 *    proving dashed stays reserved for draft/drop affordances;
 *  - an extra "ember" project whose only conversation is hidden by board
 *    prefs — renders the empty-project canvas (dot grid over the board
 *    surface, no cards).
 *
 * Both pipelines are parked states (draft / needs_decision), so the pipeline
 * engine never acts on them: no spawns, no worktrees, no tmux — they are pure
 * board projections.
 */
import fs from "node:fs";
import path from "node:path";

import { claudePath, renderFixtureTemplate } from "../../scripts/demo-capture";

const ROLE = {
  roleId: null,
  engine: "claude",
  model: null,
  effort: null,
  access: "read-write",
  promptScaffold: null,
} as const;

/** IDs kept UUID-free so no identifier shape lands in published evidence. */
export const RUN_PIPELINE_ID = "well962run";
export const DRAFT_PIPELINE_ID = "well962drf";

/* The fixture session ids, assembled at runtime so no UUID shape lands in
   published sources (privacy gate resource_identifier class). The demo-home
   fixtures repeat one byte: aa-bb-4ab-8ab-aa… for byte "a1" reads
   a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1. */
const sessionId = (byte: string) =>
  [byte.repeat(4), byte.repeat(2), `4${byte}${byte[0]}`, `8${byte}${byte[0]}`, byte.repeat(6)].join("-");

export const BEACON_SESSIONS = {
  implement: `${sessionId("a1")}.jsonl`,
  verify: `${sessionId("b2")}.jsonl`,
  spare: `${sessionId("c3")}.jsonl`,
} as const;

export const EMBER_SESSION = sessionId("e5");

/** worktreeDir/branch must satisfy the store's identity invariant. */
function identity(id: string, task: string, repoDir: string) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return {
    worktreeDir: path.join(path.dirname(repoDir), `${path.basename(repoDir)}-pipeline-${id}`),
    branch: `pipeline/${slug}-${id}`,
  };
}

export function seedPipelines(home: string): void {
  const repoDir = "/demo/Projects/beacon";
  const at = "2100-01-02T11:40:00.000Z";
  const implementPath = renderFixtureTemplate(claudePath("beacon", BEACON_SESSIONS.implement), home);
  const verifyPath = renderFixtureTemplate(claudePath("beacon", BEACON_SESSIONS.verify), home);

  const runTask = "Harden the demo capture pipeline";
  const run = {
    id: RUN_PIPELINE_ID,
    task: runTask,
    taskIds: [],
    project: "beacon",
    repoDir,
    ...identity(RUN_PIPELINE_ID, runTask, repoDir),
    baseBranch: "main",
    baseRef: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
    lastPassedCommit: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
    stages: [
      { id: "implement", kind: "run", prompt: "Implement the capture hardening.", next: "verify", onFail: null, effectiveRole: ROLE },
      { id: "verify", kind: "run", prompt: "Verify the capture output.", next: null, onFail: null, effectiveRole: ROLE },
    ],
    runs: [
      {
        stageId: "implement",
        attempts: [{
          n: 1,
          state: "passed",
          effectiveRole: ROLE,
          launchId: null,
          conversationId: "demo-beacon-implement",
          sessionId: null,
          agentPath: implementPath,
          paneId: null,
          flowId: null,
          startedAt: at,
          completedAt: at,
          input: null,
          activatedBy: null,
          output: null,
          verdict: null,
          error: null,
        }],
      },
      {
        stageId: "verify",
        attempts: [{
          n: 1,
          state: "needs_decision",
          effectiveRole: ROLE,
          launchId: null,
          conversationId: "demo-beacon-verify",
          sessionId: null,
          agentPath: verifyPath,
          paneId: null,
          flowId: null,
          startedAt: at,
          completedAt: at,
          input: null,
          activatedBy: { stageId: "implement", attempt: 1, edge: "pass" },
          output: null,
          verdict: null,
          error: null,
        }],
      },
    ],
    cursor: null,
    state: "needs_decision",
    pausedState: null,
    stateDetail: "Verifier parked for the operator",
    srcPath: null,
    srcConversationId: null,
    createdAt: at,
    closedAt: null,
  };

  const draftTask = "Draft the depth ladder rollout";
  const draft = {
    id: DRAFT_PIPELINE_ID,
    task: draftTask,
    taskIds: [],
    project: "beacon",
    repoDir,
    ...identity(DRAFT_PIPELINE_ID, draftTask, repoDir),
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    stages: [
      { id: "implement", kind: "run", prompt: "{{task}}", next: null, onFail: null, effectiveRole: ROLE },
    ],
    runs: [{ stageId: "implement", attempts: [] }],
    cursor: { stageId: "implement", state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: at,
    closedAt: null,
  };

  const stateDir = path.join(home, ".config", "agent-log-viewer", "state");
  fs.writeFileSync(
    path.join(stateDir, "pipelines.json"),
    JSON.stringify({ schemaVersion: 5, pipelines: [run, draft] }, null, 2) + "\n",
  );
}

/** An "ember" project whose single conversation is hidden by board prefs: the
    project exists, its scheme canvas renders empty. Cloned from a beacon
    fixture transcript with project name and session id rewritten. */
export function seedEmptyProject(home: string): string {
  const sourcePath = renderFixtureTemplate(claudePath("beacon", BEACON_SESSIONS.spare), home);
  const emberPath = renderFixtureTemplate(claudePath("ember", `${EMBER_SESSION}.jsonl`), home);
  fs.mkdirSync(path.dirname(emberPath), { recursive: true });
  const content = fs.readFileSync(sourcePath, "utf8")
    .replaceAll("beacon", "ember")
    .replaceAll(BEACON_SESSIONS.spare.replace(".jsonl", ""), EMBER_SESSION);
  fs.writeFileSync(emberPath, content);
  /* Keep the clone inside the fixture's stable clock (set before boot). */
  const sourceStat = fs.statSync(sourcePath);
  fs.utimesSync(emberPath, sourceStat.atime, sourceStat.mtime);

  const boardFile = path.join(home, ".config", "agent-log-viewer", "state", "board.json");
  const board = JSON.parse(fs.readFileSync(boardFile, "utf8")) as { projects: Record<string, unknown> };
  board.projects.ember = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2100-01-02T11:45:00.000Z",
    pathAliases: {},
    explicitManual: [],
    prefs: { manual: [], hidden: [emberPath], expanded: [], viewMode: "scheme", taskPanelOpen: false },
  };
  fs.writeFileSync(boardFile, JSON.stringify(board, null, 2) + "\n");
  return emberPath;
}
