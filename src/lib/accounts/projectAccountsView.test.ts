import { expect, test } from "bun:test";

import {
  accountProjectRows,
  carrierConversations,
  carryingAccountIds,
  projectEngineAccounts,
} from "./projectAccountsView";
import type { AccountProjectOverride } from "./accountOverrides";
import type { AccountProjectBinding } from "./projectBindings";

const ATLAS = "project-atlas";
const BEACON = "project-beacon";
const RESERVED = "acct-reserved";
const SPARE = "acct-spare";

const ACCOUNTS = [
  { accountId: RESERVED, label: "Reserved" },
  { accountId: SPARE, label: "Spare" },
];

function binding(accountId: string, project: string, engine: AccountProjectBinding["engine"] = "claude"): AccountProjectBinding {
  return { engine, accountId, project, createdAt: "2026-08-30T09:00:00.000Z" };
}

test("an unbound project reads as allowing every account, never as allowing none", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [], []);
  expect(view.restricted).toBe(false);
  expect(view.allowed.map((account) => account.accountId)).toEqual([RESERVED, SPARE]);
  expect(view.carrying).toEqual([]);
});

test("a bound project shows its allowed accounts with labels, and who is carrying the work", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [binding(RESERVED, ATLAS)], [RESERVED]);
  expect(view.restricted).toBe(true);
  expect(view.allowed).toEqual([{ accountId: RESERVED, label: "Reserved" }]);
  expect(view.carrying).toEqual([{ accountId: RESERVED, label: "Reserved" }]);
});

test("a bound account the catalog no longer holds still shows, under its own id", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [binding("acct-retired", ATLAS)], []);
  expect(view.allowed).toEqual([{ accountId: "acct-retired", label: "acct-retired" }]);
});

function override(over: Partial<AccountProjectOverride> = {}): AccountProjectOverride {
  return {
    at: "2026-08-30T09:00:00.000Z",
    engine: "claude",
    project: ATLAS,
    accountId: SPARE,
    allowedAccountIds: [RESERVED],
    reason: "outside-pool",
    actor: "operator",
    actorConversationId: null,
    conversationId: "conversation_one",
    via: "conversation-switch",
    ...over,
  };
}

test("an account deliberately chosen from outside the pool is shown beside it, with who and when", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [binding(RESERVED, ATLAS)], [SPARE], [override()]);
  expect(view.allowed).toEqual([{ accountId: RESERVED, label: "Reserved" }]);
  expect(view.outsidePool).toEqual([{ accountId: SPARE, label: "Spare", at: "2026-08-30T09:00:00.000Z", actor: "operator" }]);
});

test("repeating the same choice is one row, carrying the latest time", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [binding(RESERVED, ATLAS)], [], [
    override({ at: "2026-08-30T09:00:00.000Z" }),
    override({ at: "2026-08-30T11:00:00.000Z", actor: "agent" }),
    override({ at: "2026-08-30T10:00:00.000Z" }),
  ]);
  expect(view.outsidePool).toEqual([{ accountId: SPARE, label: "Spare", at: "2026-08-30T11:00:00.000Z", actor: "agent" }]);
});

test("an engine the project never bound has no pool, so nothing reads as outside one", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [], [], [override()]);
  expect(view.restricted).toBe(false);
  expect(view.outsidePool).toEqual([]);
});

test("a choice of another project, another engine, or an account since bound, is not this project's", () => {
  const view = projectEngineAccounts(ATLAS, "claude", ACCOUNTS, [binding(RESERVED, ATLAS), binding(SPARE, ATLAS)], [], [
    override({ project: BEACON }),
    override({ engine: "codex" }),
    /* Bound since the choice was made: it is inside the pool now, and the row
       would claim a boundary that no longer exists. */
    override({ accountId: SPARE }),
  ]);
  expect(view.outsidePool).toEqual([]);
});

test("carrying counts only busy conversations of the same engine and project", () => {
  const conversations = [
    { engine: "claude" as const, project: ATLAS, accountId: RESERVED, busy: true },
    { engine: "claude" as const, project: ATLAS, accountId: RESERVED, busy: true },
    { engine: "claude" as const, project: ATLAS, accountId: SPARE, busy: false },
    { engine: "claude" as const, project: BEACON, accountId: SPARE, busy: true },
    { engine: "codex" as const, project: ATLAS, accountId: SPARE, busy: true },
    { engine: "claude" as const, project: ATLAS, accountId: null, busy: true },
  ];
  expect(carryingAccountIds(conversations, ATLAS, "claude")).toEqual([RESERVED]);
  expect(carryingAccountIds(conversations, ATLAS, "codex")).toEqual([SPARE]);
});

test("the accounts side names the projects one account is bound to, with display names", () => {
  const bindings = [binding(SPARE, ATLAS), binding(SPARE, BEACON), binding(RESERVED, ATLAS), binding(SPARE, ATLAS, "codex")];
  expect(accountProjectRows("claude", SPARE, bindings, { [ATLAS]: "Atlas" })).toEqual([
    { project: ATLAS, displayName: "Atlas" },
    { project: BEACON, displayName: BEACON },
  ]);
  expect(accountProjectRows("claude", "acct-unbound", bindings)).toEqual([]);
});

/* The carrier projection resolves a conversation's project the same way the
   fence does. An ADOPTED conversation carries an empty launch profile, so a
   resolution that read only ownership and profile would answer null for it and
   the account actually carrying the project's work would never be marked —
   the display-side form of the hole the fence seams pass a fallback to close. */
const ADOPTED_TRANSCRIPT = "/transcripts/adopted.jsonl";

function source(overrides: Partial<Parameters<typeof carrierConversations>[0][number]> = {}) {
  return {
    engine: "claude" as const,
    busy: true,
    accountId: RESERVED,
    ownership: null,
    launchProfile: { project: null, cwd: null },
    path: ADOPTED_TRANSCRIPT,
    ...overrides,
  };
}

test("an adopted conversation's carrier is recovered from its transcript cwd", () => {
  const carriers = carrierConversations([source()], (transcript) =>
    (transcript === ADOPTED_TRANSCRIPT ? ATLAS : null));
  expect(carriers).toEqual([{ engine: "claude", project: ATLAS, accountId: RESERVED, busy: true }]);
  expect(carryingAccountIds(carriers, ATLAS, "claude")).toEqual([RESERVED]);
});

test("only a busy conversation with an account is a carrier, and only it costs a transcript read", () => {
  const read: string[] = [];
  const carriers = carrierConversations(
    [source({ busy: false }), source({ accountId: null }), source({ path: "/transcripts/live.jsonl" })],
    (transcript) => { read.push(transcript); return ATLAS; },
  );
  expect(carriers.map((carrier) => carrier.accountId)).toEqual([RESERVED]);
  expect(read).toEqual(["/transcripts/live.jsonl"]);
});

test("a conversation that names its own project never pays for a transcript read", () => {
  const read: string[] = [];
  const carriers = carrierConversations(
    [source({ ownership: { project: BEACON } })],
    (transcript) => { read.push(transcript); return ATLAS; },
  );
  expect(carriers[0]?.project).toBe(BEACON);
  expect(read).toEqual([]);
});
