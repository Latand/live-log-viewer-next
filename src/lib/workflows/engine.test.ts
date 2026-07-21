import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-engine-test-"));
const { createWorkflowFromRequest, patchWorkflow, tickWorkflows } = await import("./engine");
const { loadWorkflows, saveWorkflows } = await import("./store");

type Workflow = import("./types").Workflow;
type WorkflowPorts = import("./engine").WorkflowPorts;
type ExecResult = import("./provision").ExecResult;

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

const STAGES = [
  { kind: "implement", agent: { engine: "codex", model: null, effort: "xhigh" }, scope: "Backend/API" },
  { kind: "implement", agent: { engine: "claude", model: "fable", effort: null }, scope: "UI/frontend" },
  {
    kind: "review-loop",
    reviewer: { engine: "codex", model: null, effort: "xhigh" },
    fixer: { engine: "codex", model: null, effort: "low" },
    roundLimit: 5,
    reviewerMode: "headless",
  },
] as const;

function entryFor(pathname: string, engine: "claude" | "codex", mtime: number): FileEntry {
  return {
    path: pathname,
    root: engine === "claude" ? "claude-projects" : "codex-sessions",
    name: path.basename(pathname),
    project: "repo-wf",
    title: "agent",
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime,
    size: 100,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function writeCodexEntry(name: string, payload: Record<string, unknown>, mtime: number): FileEntry {
  const pathname = path.join(process.env.LLV_STATE_DIR!, "codex-fixtures", name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload }) + "\n");
  return { ...entryFor(pathname, "codex", mtime), size: fs.statSync(pathname).size };
}

/**
 * A scripted harness: every port is observable and answers from mutable
 * state, so tests walk the machine tick by tick without tmux, git or flows.
 */
function makeHarness() {
  const calls: string[] = [];
  const state = {
    execFail: null as string | null, // subcommand marker that should fail
    dirtyWorktree: false,
    spawnFail: false,
    paneDead: new Set<string>(),
    messages: new Map<string, { text: string; ts: number }>(),
    cwds: new Map<string, string>(),
    setup: "done" as "running" | "done" | "failed",
    setupDetail: "",
    flows: new Map<string, Flow>(),
    createFlowError: null as string | null,
    spawnCount: 0,
    prUrl: "https://github.com/o/r/pull/9",
    nowTick: 1_000_000,
  };
  const now = () => new Date((state.nowTick += 1000)).toISOString();
  const ports: WorkflowPorts = {
    exec: (command, args, cwd) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(`exec:${key} @${cwd}`);
      if (state.execFail && key.includes(state.execFail)) return { code: 1, stdout: "", stderr: `${state.execFail} boom` } as ExecResult;
      if (args[0] === "status" && state.dirtyWorktree) return { code: 0, stdout: " M src/x.ts\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "basesha\n", stderr: "" };
      if (command === "gh" && args[1] === "create") return { code: 0, stdout: state.prUrl + "\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    startSetup: () => {
      calls.push("startSetup");
      return { pid: 4242 };
    },
    setupStatus: () => ({ status: state.setup, detail: state.setupDetail }),
    spawnAgent: async (role, cwd, prompt) => {
      calls.push(`spawn:${role.engine}:${role.effort ?? role.model ?? "default"}`);
      if (state.spawnFail) throw new Error("tmux window failed to open");
      state.spawnCount += 1;
      const transcript = role.engine === "claude" ? `/claude/agent-${state.spawnCount}.jsonl` : null;
      if (transcript) state.cwds.set(transcript, cwd);
      void prompt;
      return { paneId: `%${state.spawnCount}`, transcript, panePid: 100 + state.spawnCount };
    },
    paneAgentAlive: async (paneId) => !state.paneDead.has(paneId),
    headCwd: (transcript) => state.cwds.get(transcript) ?? null,
    lastMessage: (entry) => state.messages.get(entry.path) ?? null,
    createFlow: async (req) => {
      calls.push(`createFlow:${req.implementerPath}:${req.baseRef}`);
      if (state.createFlowError) return { error: state.createFlowError };
      const flow = {
        id: "flow1234",
        implementerPath: req.implementerPath,
        state: "waiting_ready",
        rounds: [],
        closedAt: null,
        createdAt: now(),
      } as unknown as Flow;
      state.flows.set(flow.id, flow);
      return { flow };
    },
    advanceFlow: (id, note) => calls.push(`advanceFlow:${id}:${note.slice(0, 20)}`),
    closeFlow: async (id) => {
      calls.push(`closeFlow:${id}`);
      const flow = state.flows.get(id);
      if (flow) {
        flow.state = "closed";
        flow.closedAt = now();
      }
    },
    getFlow: (id) => state.flows.get(id) ?? null,
    findFlowByImplementer: (implementerPath) =>
      [...state.flows.values()].find((flow) => flow.implementerPath === implementerPath) ?? null,
    projectForCwd: (cwd) => (cwd === "/repos/repo" ? "repo" : null),
    linkChild: (child, parent) => calls.push(`link:${child}<-${parent}`),
    now,
  };
  return { ports, calls, state };
}

function createWf(ports: WorkflowPorts, overrides: Partial<Parameters<typeof createWorkflowFromRequest>[0]> = {}): Workflow {
  saveWorkflows([]);
  const res = createWorkflowFromRequest(
    { task: "Build the thing", repoDir: "/repos/repo", stages: STAGES as never, mode: "auto", ...overrides },
    ports,
  );
  if (!res.workflow) throw new Error(res.error);
  return res.workflow;
}

function load(id: string): Workflow {
  const wf = loadWorkflows().find((item) => item.id === id);
  if (!wf) throw new Error("workflow disappeared from the store");
  return wf;
}

/** Marks the agent's turn as finished with the given last message. */
function finishTurn(harness: ReturnType<typeof makeHarness>, transcript: string, text: string): FileEntry {
  const entry = entryFor(transcript, transcript.startsWith("/claude") ? "claude" : "codex", harness.state.nowTick / 1000 + 10);
  harness.state.messages.set(transcript, { text, ts: harness.state.nowTick + 100_000 });
  return entry;
}

test("createWorkflowFromRequest validates task, repo and stages", () => {
  const { ports } = makeHarness();
  expect(createWorkflowFromRequest({ task: " ", repoDir: "/r", stages: STAGES as never }, ports).status).toBe(400);
  expect(createWorkflowFromRequest({ task: "t", repoDir: "/r", stages: [] as never }, ports).status).toBe(400);
  expect(createWorkflowFromRequest({ task: "t", repoDir: "/r", template: "nope" }, ports).status).toBe(400);
  const { ports: failing, state } = makeHarness();
  state.execFail = "--git-dir";
  expect(createWorkflowFromRequest({ task: "t", repoDir: "/r", stages: STAGES as never }, failing).status).toBe(400);
});

test("createWorkflowFromRequest stamps the scanner project key, basename as fallback", () => {
  const { ports } = makeHarness();
  const stamped = createWf(ports);
  expect(stamped.project).toBe("repo");
  saveWorkflows([]);
  const fallback = createWorkflowFromRequest(
    { task: "t", repoDir: "/elsewhere/deep/tool-dir", stages: STAGES as never },
    ports,
  );
  expect(fallback.workflow?.project).toBe("tool-dir");
});

test("happy path: provision → two stages → review flow → PR", async () => {
  const harness = makeHarness();
  const { ports, calls, state } = harness;
  const wf = createWf(ports);
  expect(wf.state).toBe("provisioning");

  /* Tick 1: worktree + setup already done → implementing, stage 0 spawns. */
  await tickWorkflows([], ports);
  let cur = load(wf.id);
  expect(cur.baseRef).toBe("basesha");
  expect(cur.baseBranch).toBe("main");
  expect(cur.state).toBe("implementing");

  await tickWorkflows([], ports);
  cur = load(wf.id);
  expect(calls.some((call) => call.startsWith("spawn:codex:xhigh"))).toBe(true);
  expect(cur.stageRuns[0]!.paneId).toBe("%1");
  expect(cur.stageRuns[0]!.agentPath).toBeNull();

  /* Codex transcript appears in the worktree and gets claimed. */
  const stage0 = "/codex/rollout-1.jsonl";
  state.cwds.set(stage0, cur.worktreeDir);
  const stage0Entry = entryFor(stage0, "codex", state.nowTick / 1000 + 5);
  await tickWorkflows([stage0Entry], ports);
  cur = load(wf.id);
  expect(cur.stageRuns[0]!.agentPath).toBe(stage0);

  /* STAGE_DONE ends stage 0; the barrier moves to stage 1 and spawns claude. */
  const doneEntry = finishTurn(harness, stage0, "All done.\nSTAGE_DONE: API contract in src/api.ts");
  await tickWorkflows([doneEntry], ports);
  cur = load(wf.id);
  expect(cur.stageRuns[0]!.doneNote).toBe("API contract in src/api.ts");
  expect(cur.stageIndex).toBe(1);
  expect(cur.state).toBe("implementing");

  await tickWorkflows([doneEntry], ports);
  cur = load(wf.id);
  expect(calls.some((call) => call.startsWith("spawn:claude:fable"))).toBe(true);
  const stage1 = cur.stageRuns[1]!.agentPath!;
  expect(stage1).toContain("/claude/");
  /* Lineage: the UI stage descends from the backend stage. */
  expect(calls).toContain(`link:${stage1}<-${stage0}`);

  /* Stage 1 finishes → review stage: fixer spawns, flow created + advanced. */
  const uiDone = finishTurn(harness, stage1, "STAGE_DONE: UI wired to the API");
  await tickWorkflows([uiDone], ports);
  await tickWorkflows([uiDone], ports);
  cur = load(wf.id);
  expect(cur.state).toBe("reviewing");
  expect(calls.some((call) => call.startsWith("spawn:codex:low"))).toBe(true);

  const fixer = "/codex/rollout-fixer.jsonl";
  state.cwds.set(fixer, cur.worktreeDir);
  const fixerEntry = entryFor(fixer, "codex", state.nowTick / 1000 + 5);
  await tickWorkflows([fixerEntry], ports);
  await tickWorkflows([fixerEntry], ports);
  cur = load(wf.id);
  expect(cur.fixerPath).toBe(fixer);
  expect(cur.flowId).toBe("flow1234");
  expect(calls.some((call) => call.startsWith(`createFlow:${fixer}:basesha`))).toBe(true);
  expect(calls.some((call) => call.startsWith("advanceFlow:flow1234"))).toBe(true);

  /* The flow approves → finishing → push + PR → approved with the URL. */
  state.flows.get("flow1234")!.state = "approved";
  state.flows.get("flow1234")!.rounds = [{ n: 1, verdict: "APPROVE", findingsCount: 0 }] as never;
  await tickWorkflows([fixerEntry], ports);
  cur = load(wf.id);
  expect(cur.state).toBe("finishing");
  await tickWorkflows([fixerEntry], ports);
  cur = load(wf.id);
  expect(cur.state).toBe("approved");
  expect(cur.prUrl).toBe("https://github.com/o/r/pull/9");
  expect(calls.some((call) => call.includes("git push -u origin " + cur.branch))).toBe(true);
});

test("provisioning failures park the workflow: worktree add, setup start, setup exit", async () => {
  const worktree = makeHarness();
  worktree.state.execFail = "worktree add";
  const wf1 = createWf(worktree.ports);
  await tickWorkflows([], worktree.ports);
  let cur = load(wf1.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("worktree add");
  expect(cur.pausedState).toBe("provisioning");

  const setup = makeHarness();
  setup.state.setup = "failed";
  setup.state.setupDetail = "setup exited with code 3: boom";
  const wf2 = createWf(setup.ports, { setup: "bun install" });
  /* createWf builds an ad-hoc template; setup comes from the request.
     Tick 1 starts the detached setup, tick 2 sees its failure. */
  await tickWorkflows([], setup.ports);
  await tickWorkflows([], setup.ports);
  cur = load(wf2.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("code 3");
});

test("a failed stage spawn parks; retry-stage respawns fresh", async () => {
  const harness = makeHarness();
  harness.state.spawnFail = true;
  const wf = createWf(harness.ports);
  await tickWorkflows([], harness.ports); // provision → implementing
  await tickWorkflows([], harness.ports); // spawn fails
  let cur = load(wf.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("tmux window failed");

  harness.state.spawnFail = false;
  const patched = await patchWorkflow(wf.id, { action: "retry-stage" }, harness.ports);
  expect(patched.workflow?.state).toBe("implementing");
  expect(patched.workflow?.stageRuns[0]!.startedAt).toBeNull();
  await tickWorkflows([], harness.ports);
  cur = load(wf.id);
  expect(cur.stageRuns[0]!.paneId).toBe("%1");
  expect(cur.state).toBe("implementing");
});

test("a stage agent pane dying before STAGE_DONE parks the workflow", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  await tickWorkflows([], harness.ports);
  await tickWorkflows([], harness.ports); // stage 0 spawned, pane %1
  harness.state.paneDead.add("%1");
  await tickWorkflows([], harness.ports);
  const cur = load(wf.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("died");
});

test("workflow fallback claim skips a newer native Codex subagent", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  await tickWorkflows([], harness.ports);
  await tickWorkflows([], harness.ports);
  let cur = load(wf.id);
  const started = Date.parse(cur.stageRuns[0]!.startedAt!) / 1000;
  const rootId = ["019f421e", "02e1", "73e0", "9b77", "bebde063f10a"].join("-");
  const childId = ["019f423a", "d6e9", "7903", "b597", "3e676b6ff3d4"].join("-");
  const root = writeCodexEntry(`rollout-root-${rootId}.jsonl`, { id: rootId, cwd: cur.worktreeDir }, started + 5);
  const nativeChild = writeCodexEntry(
    `rollout-child-${childId}.jsonl`,
    {
      id: childId,
      parent_thread_id: rootId,
      cwd: cur.worktreeDir,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
    },
    started + 10,
  );
  harness.state.cwds.set(root.path, cur.worktreeDir);
  harness.state.cwds.set(nativeChild.path, cur.worktreeDir);

  await tickWorkflows([nativeChild, root], harness.ports);
  cur = load(wf.id);

  expect(cur.stageRuns[0]!.agentPath).toBe(root.path);
});

test("a spawn interrupted by a restart parks instead of double-spawning", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  await tickWorkflows([], harness.ports);
  /* Simulate the persisted mid-spawn shape from a previous process. */
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "implementing";
  cur.stageRuns[0]!.startedAt = new Date().toISOString();
  saveWorkflows(workflows);
  await tickWorkflows([], harness.ports);
  const after = load(wf.id);
  expect(after.state).toBe("needs_decision");
  expect(after.stateDetail).toContain("interrupted by a restart");
});

test("embedded flow trouble parks the workflow: create error, needs_decision, COMMENT, closed", async () => {
  const cases: { mutate: (harness: ReturnType<typeof makeHarness>) => void; detail: string }[] = [
    { mutate: (harness) => (harness.state.createFlowError = "no cwd"), detail: "creating the review flow failed" },
    { mutate: (harness) => harness.state.flows.set("flow1234", { id: "flow1234", state: "needs_decision", stateDetail: "round limit reached", rounds: [], closedAt: null } as never), detail: "round limit reached" },
    { mutate: (harness) => harness.state.flows.set("flow1234", { id: "flow1234", state: "done_comment", rounds: [], closedAt: null } as never), detail: "COMMENT" },
    { mutate: (harness) => harness.state.flows.set("flow1234", { id: "flow1234", state: "closed", rounds: [], closedAt: "t" } as never), detail: "was closed" },
  ];
  for (const testCase of cases) {
    const harness = makeHarness();
    const wf = createWf(harness.ports);
    const workflows = loadWorkflows();
    const cur = workflows.find((item) => item.id === wf.id)!;
    /* Jump straight to the bootstrapped review stage. */
    cur.state = "reviewing";
    cur.stageIndex = 2;
    cur.baseRef = "basesha";
    cur.baseBranch = "main";
    cur.stageRuns[2]! = { ...cur.stageRuns[2]!, startedAt: "2026-01-01T00:00:00Z", paneId: "%9", agentPath: "/codex/fixer.jsonl" };
    cur.fixerPath = "/codex/fixer.jsonl";
    if (testCase.detail !== "creating the review flow failed") cur.flowId = "flow1234";
    saveWorkflows(workflows);
    testCase.mutate(harness);
    await tickWorkflows([], harness.ports);
    const after = load(wf.id);
    expect(after.state).toBe("needs_decision");
    expect(after.stateDetail).toContain(testCase.detail);
  }
});

test("a finish failure parks; retry-stage reruns the finish", async () => {
  const harness = makeHarness();
  harness.state.execFail = "push";
  const wf = createWf(harness.ports);
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "finishing";
  cur.baseRef = "basesha";
  cur.baseBranch = "main";
  saveWorkflows(workflows);
  await tickWorkflows([], harness.ports);
  let after = load(wf.id);
  expect(after.state).toBe("needs_decision");
  expect(after.stateDetail).toContain("push");

  harness.state.execFail = null;
  await patchWorkflow(wf.id, { action: "retry-stage" }, harness.ports);
  await tickWorkflows([], harness.ports);
  after = load(wf.id);
  expect(after.state).toBe("approved");
  expect(after.prUrl).toBe("https://github.com/o/r/pull/9");
});

test("finishing a dirty worktree parks; retry after the commit publishes", async () => {
  const harness = makeHarness();
  harness.state.dirtyWorktree = true;
  const wf = createWf(harness.ports);
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "finishing";
  cur.baseRef = "basesha";
  cur.baseBranch = "main";
  saveWorkflows(workflows);
  await tickWorkflows([], harness.ports);
  let after = load(wf.id);
  expect(after.state).toBe("needs_decision");
  expect(after.stateDetail).toContain("uncommitted changes");
  expect(after.stateDetail).toContain("src/x.ts");
  expect(harness.calls.some((call) => call.includes("git push"))).toBe(false);

  harness.state.dirtyWorktree = false;
  await patchWorkflow(wf.id, { action: "retry-stage" }, harness.ports);
  await tickWorkflows([], harness.ports);
  after = load(wf.id);
  expect(after.state).toBe("approved");
  expect(after.prUrl).toBe("https://github.com/o/r/pull/9");
});

test("manual mode gates every stage boundary until advance", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports, { mode: "manual" });
  await tickWorkflows([], harness.ports); // provision → implementing
  await tickWorkflows([], harness.ports); // spawn stage 0
  const stage0 = "/codex/rollout-1.jsonl";
  harness.state.cwds.set(stage0, load(wf.id).worktreeDir);
  const entry = entryFor(stage0, "codex", harness.state.nowTick / 1000 + 5);
  await tickWorkflows([entry], harness.ports); // claim
  const done = finishTurn(harness, stage0, "STAGE_DONE: backend ready");
  await tickWorkflows([done], harness.ports);
  const cur = load(wf.id);
  expect(cur.stageRuns[0]!.doneAt).not.toBeNull();
  /* The gate: the stage is done, the index has not moved. */
  expect(cur.stageIndex).toBe(0);
  await tickWorkflows([done], harness.ports);
  expect(load(wf.id).stageIndex).toBe(0);

  const patched = await patchWorkflow(wf.id, { action: "advance" }, harness.ports);
  expect(patched.workflow?.stageIndex).toBe(1);
  expect(patched.workflow?.state).toBe("implementing");
});

test("advance force-completes a running stage with the user note", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  await tickWorkflows([], harness.ports);
  await tickWorkflows([], harness.ports); // stage 0 running
  const patched = await patchWorkflow(wf.id, { action: "advance", note: "good enough" }, harness.ports);
  expect(patched.workflow?.stageRuns[0]!.doneNote).toBe("good enough");
  expect(patched.workflow?.stageIndex).toBe(1);
});

test("advance past a live review closes the embedded flow and moves to finishing", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "reviewing";
  cur.stageIndex = 2;
  cur.flowId = "flow1234";
  saveWorkflows(workflows);
  harness.state.flows.set("flow1234", { id: "flow1234", state: "reviewing", rounds: [], closedAt: null } as never);
  const patched = await patchWorkflow(wf.id, { action: "advance" }, harness.ports);
  expect(patched.workflow?.state).toBe("finishing");
  expect(harness.calls).toContain("closeFlow:flow1234");
});

test("pause holds the phase; resume returns to it", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  await tickWorkflows([], harness.ports);
  const paused = await patchWorkflow(wf.id, { action: "pause" }, harness.ports);
  expect(paused.workflow?.state).toBe("paused");
  await tickWorkflows([], harness.ports); // parked: the tick leaves it alone
  expect(load(wf.id).state).toBe("paused");
  const resumed = await patchWorkflow(wf.id, { action: "resume" }, harness.ports);
  expect(resumed.workflow?.state).toBe("implementing");
});

test("close stops the embedded flow and keeps worktree state on the record", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "reviewing";
  cur.flowId = "flow1234";
  saveWorkflows(workflows);
  harness.state.flows.set("flow1234", { id: "flow1234", state: "reviewing", rounds: [], closedAt: null } as never);
  const closed = await patchWorkflow(wf.id, { action: "close" }, harness.ports);
  expect(closed.workflow?.state).toBe("closed");
  expect(closed.workflow?.closedAt).not.toBeNull();
  expect(closed.workflow?.worktreeDir).toContain("-wf-");
  expect(harness.calls).toContain("closeFlow:flow1234");
});

test("review transitions stop when embedded reviewer teardown fails", async () => {
  for (const action of ["advance", "retry-stage", "close"] as const) {
    const harness = makeHarness();
    const wf = createWf(harness.ports);
    const workflows = loadWorkflows();
    const cur = workflows.find((item) => item.id === wf.id)!;
    cur.state = "reviewing";
    cur.stageIndex = 2;
    cur.flowId = "flow1234";
    saveWorkflows(workflows);
    harness.state.flows.set("flow1234", { id: "flow1234", state: "reviewing", rounds: [], closedAt: null } as never);
    harness.ports.closeFlow = async () => ({ error: "reviewer process group did not terminate", status: 409 });

    const result = await patchWorkflow(wf.id, { action }, harness.ports);

    expect(result).toEqual({ error: "reviewer process group did not terminate", status: 409 });
    expect(load(wf.id)).toMatchObject({ state: "reviewing", flowId: "flow1234", closedAt: null });
  }
});

test("an orphaned flow from a restart is adopted instead of recreated", async () => {
  const harness = makeHarness();
  const wf = createWf(harness.ports);
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "reviewing";
  cur.stageIndex = 2;
  cur.baseRef = "basesha";
  cur.stageRuns[2] = { ...cur.stageRuns[2]!, startedAt: "2026-01-01T00:00:00Z", paneId: "%9", agentPath: "/codex/fixer.jsonl" };
  cur.fixerPath = "/codex/fixer.jsonl";
  saveWorkflows(workflows);
  harness.state.flows.set("flowOld", { id: "flowOld", implementerPath: "/codex/fixer.jsonl", state: "reviewing", rounds: [], closedAt: null, createdAt: "t" } as never);
  await tickWorkflows([], harness.ports);
  const after = load(wf.id);
  expect(after.flowId).toBe("flowOld");
  expect(harness.calls.filter((call) => call.startsWith("createFlow")).length).toBe(0);
});
