import { expect, test } from "bun:test";

import {
  accountProjectRows,
  carrierConversations,
  carryingAccountIds,
  projectEngineAccounts,
} from "./projectAccountsView";
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
