import { expect, test } from "bun:test";

import {
  accountProjectRows,
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
