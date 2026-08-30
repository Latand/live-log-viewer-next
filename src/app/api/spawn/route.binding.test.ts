import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/**
 * #1279 at the direct launch seam: a raw spawn resolves the project's allowed
 * set before it resolves an account, and a record it cannot read refuses.
 *
 * The refusal itself already held — nothing launches. What the first test pins
 * is the SHAPE of it: the request is well formed and the state it addresses is
 * what is wrong, so the answer is a conflict carrying the record's name, the
 * same one the reseat, the binding route and the task launch give. Answered as
 * a server fault it reads as a Viewer crash, and an operator has nothing to
 * repair from.
 *
 * The rest pin the other half, which a route can get wrong while refusing a
 * damaged record perfectly: the pool it read has to reach the resolver. This is
 * the seam every spawn surface the Viewer has arrives at — the board's button,
 * the orchestrator seat, the scheduled report launcher — and none of them names
 * an account, so all of them are the Viewer choosing.
 *
 * Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-binding-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
fs.mkdirSync(STATE, { recursive: true });
process.env.LLV_STATE_DIR = STATE;

const { POST } = await import("./route");
const { projectForCwd } = await import("@/lib/scanner/describe");
const { AgentRegistry } = await import("@/lib/agent/registry");

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(RECORD, { force: true });
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

type SpawnRouteDependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

async function spawn(cwd: string, clientAttemptId: string): Promise<{
  status: number;
  error: string;
  accountResolutions: number;
  /** The allowed set the route handed the resolver, one entry per resolution.
      `null` is a project with no binding, which is every account. */
  pools: (readonly string[] | null | undefined)[];
  receipts: number;
}> {
  const store = new AgentRegistry(path.join(SANDBOX, `${clientAttemptId}.json`));
  let accountResolutions = 0;
  /* Recorded inside the stub, because the route's own answer cannot show what
     it asked for — and what it asked for IS the fence at this seam. */
  const pools: (readonly string[] | null | undefined)[] = [];
  const dependencies = {
    registry: () => store,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async (
      _engine: unknown,
      _requested: unknown,
      allowedAccountIds?: readonly string[] | null,
    ) => {
      accountResolutions += 1;
      pools.push(allowedAccountIds);
      return {
        engine: "claude" as const,
        accountId: "acct-default",
        kind: "managed" as const,
        home: path.join(cwd, "account"),
        transcriptRoot: path.join(cwd, "projects"),
        env: { NODE_ENV: "test" as const },
      };
    },
    defer: (work: () => unknown) => { void work(); },
  } as unknown as SpawnRouteDependencies;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ title: "Inspect the atlas checkout", engine: "claude", model: "sonnet", cwd, "prompt": "inspect", clientAttemptId }),
  }), dependencies);
  const payload = await response.json() as { error?: string };
  return {
    status: response.status,
    error: payload.error ?? "",
    accountResolutions,
    pools,
    receipts: Object.keys(store.snapshot().receipts).length,
  };
}

test("a damaged binding record refuses a direct launch as a conflict naming the record, not a server fault", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "damaged-"));
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"claude"', "utf8");

  const attempt = await spawn(cwd, "binding_damaged_20260830");

  expect(attempt.status).toBe(409);
  expect(attempt.error).toContain("account-project-bindings.json");
  expect(attempt.error).toContain("repaired or removed");
  /* Refused before an account was resolved and before anything durable was
     written, so there is no receipt a retry could replay onto some account. */
  expect(attempt.accountResolutions).toBe(0);
  expect(attempt.receipts).toBe(0);
});

test("a bound project's automatic launch resolves its account against that project's pool and nothing wider", async () => {
  /* Nothing in the request names an account — the board's spawn button sends
     none — so this is the Viewer choosing, and the pool is what it may choose
     from. The refusals above prove the record is READ here; this proves what
     the reading is USED for, which is the half a launch can get wrong while
     still refusing a damaged record correctly. */
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "bound-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [
      { engine: "claude", accountId: "acct-reserved", project, createdAt: "2026-08-30T00:00:00.000Z" },
      /* A binding on another project, and one on another engine for this one:
         neither may widen or narrow what this launch is offered. */
      { engine: "claude", accountId: "acct-elsewhere", project: "project-orion", createdAt: "2026-08-30T00:00:00.000Z" },
      { engine: "codex", accountId: "acct-codex-side", project, createdAt: "2026-08-30T00:00:00.000Z" },
    ],
  }), "utf8");

  const attempt = await spawn(cwd, "binding_bound_20260830");

  expect(attempt.status).not.toBe(409);
  expect(attempt.pools).toEqual([["acct-reserved"]]);
});

test("a record nobody wrote leaves the launch resolving its account exactly as before", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "absent-"));

  const attempt = await spawn(cwd, "binding_absent_20260830");

  expect(attempt.status).not.toBe(409);
  expect(attempt.accountResolutions).toBe(1);
  /* `null`, never `[]`: an unbound project offers every account, which is the
     behaviour every project has until somebody configures one. */
  expect(attempt.pools).toEqual([null]);
});
