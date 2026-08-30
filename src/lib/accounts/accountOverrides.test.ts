import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import {
  accountProjectOverrides,
  attributeNamedAccountChoice,
} from "./accountOverrides";
import { bindAccountToProject } from "./projectBindings";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";

/**
 * The attribution half of #1279. The pool binds what the Viewer selects on its
 * own; a person or an agent naming an account is a control, and what it owes is
 * a record — never a refusal. Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-overrides-"));
const STATE = path.join(SANDBOX, "state");
const JOURNAL = path.join(STATE, "account-project-overrides.json");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = STATE;

const RESERVED = "acct-reserved";
const OUTSIDE = "acct-outside";
const ATLAS = "project-atlas";
const BEACON = "project-beacon";

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(STATE, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function choice(over: Partial<Parameters<typeof attributeNamedAccountChoice>[0]> = {}) {
  return attributeNamedAccountChoice({
    engine: "claude",
    project: ATLAS,
    accountId: OUTSIDE,
    conversationId: "conversation_one",
    actor: { kind: "operator" },
    via: "conversation-switch",
    ...over,
  });
}

test("a choice inside the pool, and one on an unbound project, are not overrides", () => {
  /* Nothing to attribute, and nothing written: the two cases that must stay
     exactly what they always were. */
  expect(choice({ accountId: OUTSIDE })).toBeNull();
  expect(fs.existsSync(JOURNAL)).toBe(false);

  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);
  expect(choice({ accountId: RESERVED })).toBeNull();
  expect(accountProjectOverrides()).toEqual([]);
});

test("a choice outside the pool is recorded with who made it, when, and what the pool was", () => {
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);

  const notice = choice({ now: () => "2026-08-30T09:00:00.000Z" });

  expect(notice).toMatchObject({
    outsidePool: true,
    accountId: OUTSIDE,
    project: ATLAS,
    allowedAccountIds: [RESERVED],
    reason: "outside-pool",
    actor: "operator",
    at: "2026-08-30T09:00:00.000Z",
    recorded: true,
  });
  expect(accountProjectOverrides()).toMatchObject([{
    at: "2026-08-30T09:00:00.000Z",
    engine: "claude",
    project: ATLAS,
    accountId: OUTSIDE,
    allowedAccountIds: [RESERVED],
    reason: "outside-pool",
    actor: "operator",
    actorConversationId: null,
    conversationId: "conversation_one",
    via: "conversation-switch",
  }]);
});

test("an agent's choice names the agent's own conversation", () => {
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);

  choice({ actor: { kind: "agent", conversationId: "conversation_caller" }, via: "structured-reconfigure" });

  expect(accountProjectOverrides()).toMatchObject([{
    actor: "agent",
    actorConversationId: "conversation_caller",
    via: "structured-reconfigure",
  }]);
});

test("a damaged binding record is recorded as unreadable, and never as a refusal", () => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, "account-project-bindings.json"), "{ not json", "utf8");

  const notice = choice();

  /* The record fails closed for the machine's own selection. It cannot answer
     for the operator, so the choice stands and the reason is on record. */
  expect(notice).toMatchObject({ outsidePool: true, reason: "binding-unreadable", allowedAccountIds: null, recorded: true });
  expect(accountProjectOverrides()).toMatchObject([{ reason: "binding-unreadable" }]);
});

test("the journal reads newest first, and narrows by project, engine and conversation", () => {
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);
  expect(bindAccountToProject("codex", RESERVED, BEACON).ok).toBe(true);

  choice({ now: () => "2026-08-30T09:00:00.000Z" });
  choice({ now: () => "2026-08-30T09:05:00.000Z", conversationId: "conversation_two" });
  choice({ now: () => "2026-08-30T09:10:00.000Z", engine: "codex", project: BEACON });

  expect(accountProjectOverrides().map((override) => override.at)).toEqual([
    "2026-08-30T09:10:00.000Z",
    "2026-08-30T09:05:00.000Z",
    "2026-08-30T09:00:00.000Z",
  ]);
  expect(accountProjectOverrides({ project: ATLAS })).toHaveLength(2);
  expect(accountProjectOverrides({ engine: "codex" })).toHaveLength(1);
  expect(accountProjectOverrides({ conversationId: "conversation_two" })).toHaveLength(1);
  expect(accountProjectOverrides({ limit: 1 })).toMatchObject([{ at: "2026-08-30T09:10:00.000Z" }]);
});

test("a damaged journal reports nothing and blocks nothing", () => {
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(JOURNAL, "{ not json", "utf8");

  /* Deliberately the OPPOSITE of the binding record's rule: nothing reads this
     file to decide whether an account may be used, so an unreadable one can
     neither widen a boundary nor park a gesture. It reports nothing, and the
     next choice writes a fresh record over it. */
  expect(accountProjectOverrides()).toEqual([]);
  expect(choice({ now: () => "2026-08-30T09:00:00.000Z" })).toMatchObject({ outsidePool: true, recorded: true });
  expect(accountProjectOverrides()).toMatchObject([{ at: "2026-08-30T09:00:00.000Z" }]);
});

test("the journal is bounded, keeping the newest entries", () => {
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);
  for (let index = 0; index < 205; index += 1) {
    choice({ now: () => `2026-08-30T09:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z` });
  }
  const stored = accountProjectOverrides();
  expect(stored).toHaveLength(200);
  expect(stored[0]?.at).toContain(".204Z");
});

test("a journal that cannot take the record says so, and still does not refuse the choice", () => {
  expect(bindAccountToProject("claude", RESERVED, ATLAS).ok).toBe(true);
  /* Nothing can be appended at a pathname that is a directory. */
  fs.mkdirSync(JOURNAL, { recursive: true });

  const notice = choice({ now: () => "2026-08-30T09:00:00.000Z" });

  /* Both halves of the same rule. The switch stands, because a record that
     would not write is not a decision anybody made — and the answer carries
     the reason, because a choice the panel will never show is exactly what
     this journal exists to prevent, so it cannot be reduced to a flag nobody
     reads. */
  expect(notice).toMatchObject({ outsidePool: true, accountId: OUTSIDE, reason: "outside-pool", recorded: false });
  expect(notice?.recordFailure).toBeTruthy();
  expect(accountProjectOverrides()).toEqual([]);
});
