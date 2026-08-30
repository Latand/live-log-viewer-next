import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  accountProjectBindings,
  allowedAccountIdsForProject,
  bindAccountToProject,
  projectAccountRefusalDetail,
  projectAllowsAccount,
  projectsForAccount,
  resetAccountProjectBindingsForTests,
  unbindAccountFromProject,
} from "./projectBindings";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-project-bindings-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const RESERVED = "acct-reserved";
const SHARED = "acct-shared";
const ATLAS = "project-atlas";
const BEACON = "project-beacon";

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetAccountProjectBindingsForTests();
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

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
  resetAccountProjectBindingsForTests();
  expect(accountProjectBindings()).toEqual(added.bindings);

  const again = bindAccountToProject("claude", RESERVED, ATLAS);
  expect(again).toMatchObject({ ok: true, changed: false });

  const removed = unbindAccountFromProject("claude", RESERVED, ATLAS);
  expect(removed).toMatchObject({ ok: true, changed: true });
  if (!removed.ok) throw new Error("unbind refused");
  expect(removed.bindings).toEqual([]);
  resetAccountProjectBindingsForTests();
  expect(accountProjectBindings()).toEqual([]);
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();

  expect(unbindAccountFromProject("claude", RESERVED, ATLAS)).toMatchObject({ ok: true, changed: false });
});

test("a write that cannot land is refused rather than reported ok", () => {
  const stateDir = process.env.LLV_STATE_DIR!;
  fs.mkdirSync(stateDir, { recursive: true });
  /* A directory where the record belongs: the rename fails, so the write
     fails, and the mutation must say so instead of answering ok. */
  fs.mkdirSync(path.join(stateDir, "account-project-bindings.json"), { recursive: true });
  try {
    const result = bindAccountToProject("claude", RESERVED, ATLAS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a failed write was reported as ok");
    expect(result.code).toBe("STORE_ERROR");
    expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();
  } finally {
    fs.rmSync(path.join(stateDir, "account-project-bindings.json"), { recursive: true, force: true });
  }
});

test("malformed input is refused with the field it names, and changes nothing", () => {
  expect(bindAccountToProject("gemini", RESERVED, ATLAS)).toMatchObject({ ok: false, code: "INVALID_ENGINE" });
  expect(bindAccountToProject("claude", "  ", ATLAS)).toMatchObject({ ok: false, code: "INVALID_ACCOUNT" });
  expect(bindAccountToProject("claude", RESERVED, "")).toMatchObject({ ok: false, code: "INVALID_PROJECT" });
  expect(accountProjectBindings()).toEqual([]);
});

test("an unreadable record reads as no bindings, so a corrupt file cannot fence a project shut", () => {
  bindAccountToProject("claude", RESERVED, ATLAS);
  const file = path.join(process.env.LLV_STATE_DIR!, "account-project-bindings.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  resetAccountProjectBindingsForTests();
  expect(accountProjectBindings()).toEqual([]);
  expect(allowedAccountIdsForProject(ATLAS, "claude")).toBeNull();
});

test("a project spelled by an alias source reads the binding its target holds", () => {
  /* The scanner answers with the pre-convergence id for a checkout whose
     repository identities have since converged. Written from one spelling and
     read from the other, the fence has to be the same fence. */
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"),
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
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), { force: true });
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
