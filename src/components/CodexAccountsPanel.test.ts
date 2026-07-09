import { expect, test } from "bun:test";

import type { CodexAccountOption } from "@/hooks/useCodexAccounts";

import { accountRowState } from "./CodexAccountsPanel";
import { accountSwitchView } from "./CodexAccountSwitch";

const base: CodexAccountOption = { id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null };

test("the active authenticated account reads as active", () => {
  expect(accountRowState(base, "work")).toBe("active");
});

test("a login in flight is pending regardless of which account is active", () => {
  const pending: CodexAccountOption = { ...base, authPresent: false, loginPending: true, loginState: "pending" };
  expect(accountRowState(pending, "work")).toBe("pending");
  expect(accountRowState(pending, "default")).toBe("pending");
});

test("an unauthenticated account needs sign-in even while it is the active one", () => {
  expect(accountRowState({ ...base, authPresent: false }, "work")).toBe("needsLogin");
});

test("an authenticated non-active account is idle", () => {
  expect(accountRowState(base, "default")).toBe("idle");
});

test("accountSwitchView keeps loading and recovery states visible", () => {
  expect(accountSwitchView([], "loading")).toBe("loading");
  expect(accountSwitchView([], "error")).toBe("error");
  expect(accountSwitchView([base], "ready")).toBe("switch");
});
