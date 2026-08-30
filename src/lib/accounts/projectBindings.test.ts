import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  AccountProjectBindingsUnreadableError,
  accountProjectBindings,
  allowedAccountIdsForProject,
  bindAccountToProject,
  projectAccountRefusalDetail,
  projectAllowsAccount,
  projectsForAccount,
  unbindAccountFromProject,
} from "./projectBindings";
import { withAccountMutationLockAsync } from "./accountMutation";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-project-bindings-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const STATE = path.join(SANDBOX, "state");
process.env.LLV_STATE_DIR = STATE;
const RECORD = path.join(STATE, "account-project-bindings.json");

const RESERVED = "acct-reserved";
const SHARED = "acct-shared";
const ATLAS = "project-atlas";
const BEACON = "project-beacon";

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  process.env.LLV_STATE_DIR = STATE;
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** Puts `content` on record, bypassing the store, the way damage arrives. */
function damage(content: string): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, content, "utf8");
}

test("an unbound project allows every account, and the first binding is what fences it", () => {
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();
  expect(projectAllowsAccount(ATLAS, "claude", SHARED)).toBe(true);

  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);

  expect(allowedAccountIdsForProject(ATLAS, "claude")).toEqual([RESERVED]);
  expect(projectAllowsAccount(ATLAS, "claude", RESERVED)).toBe(true);
  expect(projectAllowsAccount(ATLAS, "claude", SHARED)).toBe(false);
  /* Every OTHER project is untouched by the binding — the constraint is opt-in
     per project, so nothing changes for anyone who never configures it. */
  expect(allowedAccountIdsForProject(BEACON, "claude")).toBeNull();
  expect(projectAllowsAccount(BEACON, "claude", RESERVED)).toBe(true);
});

test("the fence is per engine: a Claude binding leaves the project's Codex selection open", () => {
  bindAccountToProject("claude", RESERVED, ATLAS);
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toEqual([RESERVED]);
  expect(allowedAccountIdsForProject(ATLAS, "codex")).toBeNull();
  expect(projectAllowsAccount(ATLAS, "codex", SHARED)).toBe(true);
});

test("the relation is many-to-many in both directions", () => {
  bindAccountToProject("claude", RESERVED, ATLAS);
  bindAccountToProject("claude", SHARED, ATLAS);
  bindAccountToProject("claude", SHARED, BEACON);

  expect(allowedAccountIdsForProject(ATLAS, "claude")).toEqual([RESERVED, SHARED]);
  expect(projectsForAccount("claude", SHARED)).toEqual([ATLAS, BEACON]);
  expect(projectsForAccount("claude", RESERVED)).toEqual([ATLAS]);
});

test("a mutation is confirmed by the record read back, not by its own echo", () => {
  const added = bindAccountToProject("claude", RESERVED, ATLAS);
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error("bind refused");
  expect(added.changed).toBe(true);
  /* The returned bindings come from a fresh read of the file, so an independent
     read of the same store has to agree with them exactly. */
  expect(added.bindings).toEqual(accountProjectBindings());

  const again = bindAccountToProject("claude", RESERVED, ATLAS);
  expect(again).toMatchObject({ ok: true, changed: false });

  const removed = unbindAccountFromProject("claude", RESERVED, ATLAS);
  expect(removed).toMatchObject({ ok: true, changed: true });
  if (!removed.ok) throw new Error("unbind refused");
  expect(removed.bindings).toEqual([]);
  expect(accountProjectBindings()).toEqual([]);
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();

  expect(unbindAccountFromProject("claude", RESERVED, ATLAS)).toMatchObject({ ok: true, changed: false });
});

test("a write that cannot land is refused rather than reported ok", async () => {
  /* A state directory that cannot be created: its parent is a FILE. The read
     answers "no record" (ENOTDIR is one of the two ways a record is absent) and
     the write cannot put one there, which is the one shape of write failure a
     test can produce without depending on the uid it runs as.

     Held inside an already-acquired account mutation transaction on purpose:
     the store re-enters that transaction instead of taking the lock a second
     time, so this also covers the composition the API route uses. */
  const blocker = path.join(SANDBOX, "not-a-directory");
  fs.writeFileSync(blocker, "occupied", "utf8");
  fs.mkdirSync(STATE, { recursive: true });
  await withAccountMutationLockAsync(async () => {
    process.env.LLV_STATE_DIR = path.join(blocker, "state");
    try {
      const result = bindAccountToProject("claude", RESERVED, ATLAS);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a failed write was reported as ok");
      expect(result.code).toBe("STORE_ERROR");
      expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();
    } finally {
      process.env.LLV_STATE_DIR = STATE;
    }
  });
  fs.rmSync(blocker, { force: true });
});

test("malformed input is refused with the field it names, and changes nothing", () => {
  expect(bindAccountToProject("gemini", RESERVED, ATLAS)).toMatchObject({ ok: false, code: "INVALID_ENGINE" });
  expect(bindAccountToProject("claude", "  ", ATLAS)).toMatchObject({ ok: false, code: "INVALID_ACCOUNT" });
  expect(bindAccountToProject("claude", RESERVED, "")).toMatchObject({ ok: false, code: "INVALID_PROJECT" });
  expect(accountProjectBindings()).toEqual([]);
});

/* The record has three states and only ONE of them means unbound. A damaged
   record read as an empty list would say "no project is bound", which allows
   every account on precisely the projects a binding was written to reserve —
   the reservation would disappear in the condition where it matters most. */
const DAMAGED: readonly [name: string, content: string][] = [
  ["an empty file", ""],
  ["truncated JSON", '{"schemaVersion":1,"bindings":[{"engine":"claude","accountId":"acct-reserved"'],
  ["text that is not JSON at all", "{ not json"],
  ["a JSON null", "null"],
  ["a JSON array at the root", "[]"],
  ["a JSON string at the root", '"account-project-bindings"'],
  ["a schema version from the future", '{"schemaVersion":2,"bindings":[]}'],
  ["no schema version", '{"bindings":[]}'],
  ["a schema version that is not a number", '{"schemaVersion":"1","bindings":[]}'],
  ["no bindings key", '{"schemaVersion":1}'],
  ["bindings that are not a list", '{"schemaVersion":1,"bindings":{}}'],
  ["a null row", '{"schemaVersion":1,"bindings":[null]}'],
  ["a row for an engine that does not exist", '{"schemaVersion":1,"bindings":[{"engine":"gemini","accountId":"acct-reserved","project":"project-atlas","createdAt":"2026-08-30T00:00:00.000Z"}]}'],
  ["a row with a blank account", '{"schemaVersion":1,"bindings":[{"engine":"claude","accountId":"   ","project":"project-atlas","createdAt":"2026-08-30T00:00:00.000Z"}]}'],
  ["a row with a numeric project", '{"schemaVersion":1,"bindings":[{"engine":"claude","accountId":"acct-reserved","project":7,"createdAt":"2026-08-30T00:00:00.000Z"}]}'],
  ["one good row and one damaged row", '{"schemaVersion":1,"bindings":[{"engine":"claude","accountId":"acct-reserved","project":"project-atlas","createdAt":"2026-08-30T00:00:00.000Z"},{"engine":"claude","project":"project-atlas"}]}'],
];

for (const [name, content] of DAMAGED) {
  test(`a record with ${name} refuses every read and never widens a project`, () => {
    damage(content);
    expect(() => accountProjectBindings()).toThrow(AccountProjectBindingsUnreadableError);
    /* The two answers that would widen: null ("this project is unbound, every
       account may carry it") and true ("this account is allowed"). */
    expect(() => allowedAccountIdsForProject(ATLAS, "claude")).toThrow(AccountProjectBindingsUnreadableError);
    expect(() => allowedAccountIdsForProject(BEACON, "codex")).toThrow(AccountProjectBindingsUnreadableError);
    expect(() => projectAllowsAccount(ATLAS, "claude", SHARED)).toThrow(AccountProjectBindingsUnreadableError);
    expect(() => projectAllowsAccount(null, "claude", SHARED)).toThrow(AccountProjectBindingsUnreadableError);
    expect(() => projectsForAccount("claude", RESERVED)).toThrow(AccountProjectBindingsUnreadableError);
  });
}

test("a record this process cannot read at all is damaged, not absent", () => {
  /* A directory where the record belongs: it exists, and no read of it can
     produce a binding list — for any uid. */
  fs.mkdirSync(RECORD, { recursive: true });
  expect(() => allowedAccountIdsForProject(ATLAS, "claude")).toThrow(AccountProjectBindingsUnreadableError);
  expect(() => accountProjectBindings()).toThrow(/the read failed with EISDIR/);
  expect(bindAccountToProject("claude", RESERVED, ATLAS)).toMatchObject({ ok: false, code: "RECORD_UNREADABLE" });
  fs.rmSync(RECORD, { recursive: true, force: true });
});

test("a damaged record refuses both mutations and is left exactly as it was", () => {
  const content = '{"schemaVersion":1,"bindings":[{"engine":"claude","accountId":"acct-reserved"';
  damage(content);

  const added = bindAccountToProject("claude", RESERVED, ATLAS);
  expect(added).toMatchObject({ ok: false, code: "RECORD_UNREADABLE", bindings: [] });
  if (added.ok) throw new Error("a damaged record accepted a binding");
  expect(added.message).toContain("account-project-bindings.json");
  expect(added.message).toContain("repaired or removed");

  const removed = unbindAccountFromProject("claude", RESERVED, ATLAS);
  expect(removed).toMatchObject({ ok: false, code: "RECORD_UNREADABLE" });

  /* Refusing without writing is also what keeps the damaged record intact for
     repair: a mutation that read it as empty would have replaced it with its
     own single row and taken every other binding with it. */
  expect(fs.readFileSync(RECORD, "utf8")).toBe(content);
});

test("an absent record is the only state that means unbound", () => {
  expect(fs.existsSync(RECORD)).toBe(false);
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();
  expect(projectAllowsAccount(ATLAS, "claude", SHARED)).toBe(true);
  expect(accountProjectBindings()).toEqual([]);

  /* And a record damaged AFTER a fence was written does not release it: the
     project stops selecting accounts instead of accepting all of them. */
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);
  expect(projectAllowsAccount(ATLAS, "claude", SHARED)).toBe(false);
  damage("{ not json");
  expect(() => projectAllowsAccount(ATLAS, "claude", SHARED)).toThrow(AccountProjectBindingsUnreadableError);

  /* Removing the damaged record is the repair, and it restores the state the
     project had before anyone bound it. */
  fs.rmSync(RECORD, { force: true });
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();
});

test("a project spelled by an alias source reads the binding its target holds", () => {
  /* The scanner answers with the pre-convergence id for a checkout whose
     repository identities have since converged. Written from one spelling and
     read from the other, the fence has to be the same fence. */
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(
    path.join(STATE, "project-aliases.json"),
    JSON.stringify({ schemaVersion: 1, aliases: { "project-atlas-old": ATLAS }, displayNames: { [ATLAS]: "Atlas" } }),
    "utf8",
  );
  resetProjectAliasesForTests();

  expect(bindAccountToProject("claude", RESERVED, "project-atlas-old").ok).toBe(true);
  expect(accountProjectBindings()).toMatchObject([{ project: ATLAS }]);
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toEqual([RESERVED]);
  expect(allowedAccountIdsForProject("project-atlas-old", "claude")).toEqual([RESERVED]);
  expect(projectAllowsAccount("project-atlas-old", "claude", SHARED)).toBe(false);

  expect(unbindAccountFromProject("claude", RESERVED, ATLAS)).toMatchObject({ ok: true, changed: true });
  expect(allowedAccountIdsForProject("project-atlas-old", "claude")).toBeNull();
  fs.rmSync(path.join(STATE, "project-aliases.json"), { force: true });
  resetProjectAliasesForTests();
});

test("the refusal wording names capacity, the project and the accounts it may use", () => {
  expect(projectAccountRefusalDetail(
    { kind: "not_allowed", accountId: SHARED, allowedAccountIds: [RESERVED] },
    "claude",
    ATLAS,
  )).toBe(`claude account ${SHARED} is not allowed on project ${ATLAS} (allowed claude accounts: ${RESERVED})`);

  expect(projectAccountRefusalDetail(
    { kind: "exhausted", resetsAt: null, allowedAccountIds: [RESERVED] },
    "claude",
    ATLAS,
  )).toBe(`no allowed claude account has capacity for project ${ATLAS} (allowed claude accounts: ${RESERVED}); resetsAt=unknown`);

  expect(projectAccountRefusalDetail(
    { kind: "unavailable", allowedAccountIds: [] },
    "codex",
    BEACON,
  )).toBe(`no allowed codex account is available for project ${BEACON} (project ${BEACON} allows no codex account)`);
});
