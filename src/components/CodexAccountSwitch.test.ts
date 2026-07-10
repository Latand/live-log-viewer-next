import { expect, test } from "bun:test";

import { accountSwitchView, pendingDeviceAuth } from "./CodexAccountSwitch";

const account = { id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated" as const, deviceAuth: null };

test("an initial refresh failure with no accounts still surfaces an account control", () => {
  expect(accountSwitchView([], "error")).toBe("error");
});

test("loading with no accounts keeps the control available", () => {
  expect(accountSwitchView([], "loading")).toBe("loading");
});

test("any loaded account shows the full switcher regardless of a lingering note", () => {
  expect(accountSwitchView([account], "ready")).toBe("switch");
  expect(accountSwitchView([account], "error")).toBe("switch");
});

test("account selector exposes only a pending device challenge", () => {
  expect(pendingDeviceAuth([
    { id: "default", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: { url: "https://auth.openai.com/hidden", code: "HIDE-ME" } },
    { id: "work", label: "Work", authPresent: false, loginPending: true, loginState: "pending", deviceAuth: { url: "https://auth.openai.com/codex/device", code: "ABCD-1234" } },
  ])).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-1234" });
});
