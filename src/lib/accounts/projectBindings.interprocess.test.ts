import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

/* Real processes, one throwaway state directory, no runtime host and no
   registry: the only shared thing under contention is the binding record. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-project-bindings-processes-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const STATE = path.join(SANDBOX, "state");
process.env.LLV_STATE_DIR = STATE;
const RECORD = path.join(STATE, "account-project-bindings.json");

const { accountProjectBindings, bindAccountToProject, unbindAccountFromProject } = await import("./projectBindings");

const ATLAS = "project-atlas";
const MODULE = path.join(import.meta.dir, "projectBindings.ts");
const CONTENDERS = 16;

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

type ContenderResult = { accountId: string; action: string; ok: boolean; code: string | null; message: string | null };

/**
 * One mutation per process, retrying only the answer that says "nothing was
 * decided and nothing was written" — which is what a caller does, and what
 * keeps this a test of the transaction rather than of how many contenders the
 * lock turns away.
 */
function contender(accountId: string, action: "add" | "remove"): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: [process.execPath, "-e", `
      const store = await import(${JSON.stringify(MODULE)});
      const accountId = process.env.LLV_TEST_ACCOUNT_ID;
      const action = process.env.LLV_TEST_ACTION;
      let result = { ok: false, code: "NEVER_RAN", message: null };
      try {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          result = action === "add"
            ? store.bindAccountToProject("claude", accountId, ${JSON.stringify(ATLAS)})
            : store.unbindAccountFromProject("claude", accountId, ${JSON.stringify(ATLAS)});
          if (result.ok || result.code !== "BUSY") break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      } catch (error) {
        result = { ok: false, code: "THREW", message: String((error && error.message) || error) };
      }
      process.stdout.write(JSON.stringify({
        accountId,
        action,
        ok: result.ok === true,
        code: result.ok ? null : result.code,
        message: result.ok ? null : result.message ?? null,
      }));
    `],
    env: { ...process.env, LLV_STATE_DIR: STATE, LLV_TEST_ACCOUNT_ID: accountId, LLV_TEST_ACTION: action },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function results(children: ReturnType<typeof Bun.spawn>[]): Promise<ContenderResult[]> {
  return await Promise.all(children.map(async (child) => {
    const [out, error, exit] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      child.exited,
    ]);
    if (exit !== 0 || !out) throw new Error(`contender exited ${exit}: ${error || "no output"}`);
    return JSON.parse(out) as ContenderResult;
  }));
}

test("concurrent adds from separate processes never lose a row", async () => {
  const accounts = Array.from({ length: CONTENDERS }, (_, index) => `acct-${String(index).padStart(2, "0")}`);
  const answers = await results(accounts.map((accountId) => contender(accountId, "add")));

  /* The failure this replaces: an unlocked read-modify-write answered `ok` to
     fifteen of sixteen adds and left thirteen rows on record. A project whose
     sole binding is one of the lost rows is open to every account again. */
  expect(answers.filter((answer) => answer.code === "THREW")).toEqual([]);
  const succeeded = answers.filter((answer) => answer.ok).map((answer) => answer.accountId).sort();
  const onRecord = accountProjectBindings().map((binding) => binding.accountId).sort();
  expect(succeeded.filter((accountId) => !onRecord.includes(accountId))).toEqual([]);

  /* Every contender is distinct, so the queue serialises them all: sixteen
     answers of `ok`, sixteen rows, and no duplicates. */
  expect(succeeded).toEqual(accounts);
  expect(onRecord).toEqual(accounts);
  expect(new Set(onRecord).size).toBe(CONTENDERS);
});

test("concurrent adds and removes leave the record agreeing with every answer", async () => {
  const kept = Array.from({ length: CONTENDERS / 2 }, (_, index) => `acct-keep-${index}`);
  const dropped = Array.from({ length: CONTENDERS / 2 }, (_, index) => `acct-drop-${index}`);
  for (const accountId of dropped) expect(bindAccountToProject("claude", accountId, ATLAS).ok).toBe(true);

  const answers = await results([
    ...kept.map((accountId) => contender(accountId, "add")),
    ...dropped.map((accountId) => contender(accountId, "remove")),
  ]);
  expect(answers.filter((answer) => answer.code === "THREW")).toEqual([]);
  expect(answers.filter((answer) => !answer.ok)).toEqual([]);

  const onRecord = accountProjectBindings().map((binding) => binding.accountId).sort();
  expect(onRecord).toEqual([...kept].sort());
  /* A removal that reported success is gone, an add that reported success is
     present, and neither erased the other's work. */
  for (const accountId of dropped) expect(onRecord).not.toContain(accountId);
});

test("a record damaged mid-flight refuses every process instead of opening the project", async () => {
  expect(bindAccountToProject("claude", "acct-reserved", ATLAS).ok).toBe(true);
  const content = '{"schemaVersion":1,"bindings":[{"engine":"claude"';
  fs.writeFileSync(RECORD, content, "utf8");

  const answers = await results([
    contender("acct-intruder", "add"),
    contender("acct-reserved", "remove"),
  ]);
  for (const answer of answers) {
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("RECORD_UNREADABLE");
  }
  /* No process wrote over the damaged record, so the repair is still possible
     and no project silently became unbound. */
  expect(fs.readFileSync(RECORD, "utf8")).toBe(content);
  expect(unbindAccountFromProject("claude", "acct-reserved", ATLAS)).toMatchObject({ ok: false, code: "RECORD_UNREADABLE" });
}, 20_000);
