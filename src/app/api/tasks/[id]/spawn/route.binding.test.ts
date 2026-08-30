import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { BoardTask } from "@/lib/tasks/types";

/**
 * #1279 at the task launch seam, which is the purest AUTOMATIC one there is:
 * the board's spawn and retry buttons send no account at all, so the account
 * this route runs work on is entirely the Viewer's own pick — and a pick is
 * exactly what a project's pool binds. Until this fence existed the route
 * resolved the engine's ACTIVE account and never asked the record, so a project
 * that reserved one account still had its task launched on another.
 *
 * The three cases the rule names, at this one seam: an unbound project is
 * untouched, a bound project whose pool holds no usable account is REPORTED
 * rather than widened, and a record this process cannot read refuses instead of
 * reading as "nobody bound anything".
 *
 * Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-spawn-binding-"));
const STATE = path.join(SANDBOX, "state");
const HOME = path.join(SANDBOX, "home");
/* The Claude home the legacy account resolves to. Named explicitly rather than
   derived from HOME: `os.homedir()` is read once per process, so reassigning
   `process.env.HOME` inside a test file would still leave the account pointing
   at the real one. */
const CLAUDE_HOME = path.join(HOME, ".claude");
const RECORD = path.join(STATE, "account-project-bindings.json");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.LLV_STATE_DIR = STATE;
process.env.HOME = HOME;
process.env.LLV_CLAUDE_HOME = CLAUDE_HOME;
/* That account's credential, written the way the safety check demands, so it
   is an account the automatic pick may actually choose. Without it every
   account reads as unauthenticated and a bound project has no candidate at
   all — a different refusal from the one under test. */
fs.mkdirSync(CLAUDE_HOME, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(CLAUDE_HOME, ".credentials.json"), "{}", { encoding: "utf8", mode: 0o600 });

const { POST } = await import("./route");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { projectInfoFromCwd } = await import("@/lib/scanner/describe");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
const { listClaudeAccounts } = await import("@/lib/accounts/claude");

/** The board task's project, and the accounts nobody on this machine has. */
const ATLAS = "project-atlas";
const RESERVED = "acct-reserved";
/** An account a task once ran on and that no longer exists. */
const RETIRED = "acct-retired";

/** The project key the route resolves for a directory — the same one the launch
    profile is stamped with, so the fence and the board agree on the name. */
function projectOf(cwd: string): string {
  return projectInfoFromCwd(cwd)?.project ?? ATLAS;
}

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  process.env.HOME = HOME;
  process.env.LLV_CLAUDE_HOME = CLAUDE_HOME;
  fs.rmSync(RECORD, { force: true });
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CLAUDE_HOME === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = ORIGINAL_CLAUDE_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function taskFor(id: string, assignments: BoardTask["assignments"] = []): BoardTask {
  return {
    id,
    project: ATLAS,
    status: "inbox",
    text: "Launch the atlas task",
    placement: "pinned",
    pos: { x: 0, y: 0 },
    assignments,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
}

/** An assignment as a first launch leaves it: an account nobody named, kept by
    retries for continuity. */
function ranOn(accountId: string): BoardTask["assignments"] {
  return [{
    path: null,
    panePid: null,
    state: "delivered",
    error: null,
    at: "2026-08-30T12:00:00.000Z",
    accountId,
    engine: "claude",
  }];
}

interface LaunchAttempt {
  status: number;
  error: string;
  spawnCalls: number;
  writes: number;
  receipts: number;
}

/**
 * One task launch, with the task store and the pane substituted and the REAL
 * account resolution left in place — the seam the rule lives in.
 */
async function launch(
  id: string,
  cwd: string,
  assignments: BoardTask["assignments"] = [],
): Promise<LaunchAttempt> {
  const registry = new AgentRegistry(path.join(SANDBOX, `${id}.json`), undefined, undefined, { sqliteMode: "off" });
  let tasks: BoardTask[] = [taskFor(id, assignments)];
  let spawnCalls = 0;
  let writes = 0;
  const response = await POST.withDependencies(
    new NextRequest(`http://127.0.0.1/api/tasks/${id}/spawn`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ engine: "claude", cwd }),
    }),
    { params: Promise.resolve({ id }) },
    {
      ...POST.productionDependencies,
      registry: () => registry,
      loadTasks: () => tasks,
      mutateTasks: ((mutator: (current: BoardTask[]) => { tasks?: BoardTask[]; result: unknown }) => {
        writes += 1;
        const mutation = mutator(tasks);
        if (mutation.tasks) tasks = mutation.tasks;
        return mutation.result;
      }) as typeof POST.productionDependencies.mutateTasks,
      resolveSpawnedTranscriptPath: async () => null,
      spawnAgentWithPrompt: async () => {
        spawnCalls += 1;
        throw new Error("the pane must stay unreachable");
      },
      ensureTaskPipelineForAssignment: undefined,
      recordOperatorActivity: undefined,
    },
  );
  const payload = await response.json() as { error?: string };
  return {
    status: response.status,
    error: payload.error ?? "",
    spawnCalls,
    writes,
    receipts: Object.keys(registry.snapshot().receipts).length,
  };
}

function bind(engine: "claude" | "codex", accountId: string, project: string): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine, accountId, project, createdAt: "2026-08-30T12:00:00.000Z" }],
  }), "utf8");
}

test("a project bound to an account this machine does not have refuses the launch instead of using the active one", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "atlas-bound-"));
  bind("claude", RESERVED, projectOf(cwd));

  const attempt = await launch("10410100-89c5-0064-9118-51661c4f1041", cwd);

  /* The state the request addresses is what is wrong, not the request. */
  expect(attempt.status).toBe(409);
  expect(attempt.error).toContain(projectOf(cwd));
  expect(attempt.error).toContain(RESERVED);
  /* And the refusal is total: no pane, no assignment, no durable receipt that
     would let a retry replay the crossing. */
  expect(attempt.spawnCalls).toBe(0);
  expect(attempt.writes).toBe(0);
  expect(attempt.receipts).toBe(0);
});

test("a binding record that cannot be read refuses the launch rather than reading as unbound", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "atlas-damaged-"));
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"claude"', "utf8");

  const attempt = await launch("10410101-89c5-0064-9118-51661c4f1041", cwd);

  expect(attempt.status).toBe(409);
  expect(attempt.error).toContain("account-project-bindings.json");
  expect(attempt.error).toContain("repaired or removed");
  expect(attempt.spawnCalls).toBe(0);
  expect(attempt.writes).toBe(0);
  expect(attempt.receipts).toBe(0);
});

test("a project nobody bound launches exactly as it did before, reaching the pane", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "atlas-unbound-"));

  const attempt = await launch("10410102-89c5-0064-9118-51661c4f1041", cwd);

  /* Nothing about the account was refused: resolution passed and the launch
     went all the way to the pane this harness refuses to open. */
  expect(attempt.spawnCalls).toBe(1);
  expect(attempt.status).not.toBe(409);
});

test("a binding for the OTHER engine leaves this engine's launch unbound", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "atlas-other-engine-"));
  bind("codex", RESERVED, projectOf(cwd));

  const attempt = await launch("10410103-89c5-0064-9118-51661c4f1041", cwd);

  /* Restriction begins for an engine at that engine's first binding; a Claude
     launch on a project with only a Codex row is untouched. */
  expect(attempt.spawnCalls).toBe(1);
  expect(attempt.status).not.toBe(409);
});

/**
 * The account a first launch resolved is CONTINUITY, not a pin: nobody named
 * it, the assignment simply keeps it so retries land where the work started.
 * Passed to the project seam as a pin it made a bound project refuse its own
 * task launch while the pool it was given sat idle — the automatic path
 * declining to draw from the pool, which is exactly what the rule asks it to
 * do. A preference loses to the fence and the launch proceeds.
 */
test("a task that already ran on an account the project no longer allows launches on the pool instead of refusing", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "atlas-reseat-"));
  const usable = listClaudeAccounts()[0]!.id;
  bind("claude", usable, projectOf(cwd));

  const attempt = await launch("10410104-89c5-0064-9118-51661c4f1041", cwd, ranOn(RETIRED));

  /* The pool had capacity, so nothing is refused and nothing crosses: the
     launch reaches the pane on the one account the project allows. */
  expect(attempt.status).not.toBe(409);
  expect(attempt.error).not.toContain(RETIRED);
  expect(attempt.spawnCalls).toBe(1);
});

test("an unbound project still launches a retry on the account the task already ran on", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "atlas-continuity-"));

  const attempt = await launch("10410105-89c5-0064-9118-51661c4f1041", cwd, ranOn(RETIRED));

  /* Unchanged, down to the failure: with no binding the preference IS the
     account, so a task whose account has since been removed reports that
     account as unknown rather than quietly starting somewhere else. It is a
     bad account and not a fenced one, so it is a 400 and never a 409. */
  expect(attempt.status).toBe(400);
  expect(attempt.error).toContain(RETIRED);
  expect(attempt.spawnCalls).toBe(0);
});
