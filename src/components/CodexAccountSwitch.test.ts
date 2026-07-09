import { expect, test } from "bun:test";

import { accountSwitchView, pendingDeviceAuth } from "./CodexAccountSwitch";

const account = { id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated" as const, deviceAuth: null };

test("an initial refresh failure with no accounts still surfaces a recovery affordance", () => {
  expect(accountSwitchView([], "Could not refresh accounts. Try again.")).toBe("recovery");
});

test("no accounts and no failure note hides the control", () => {
  expect(accountSwitchView([], "")).toBe("hidden");
});

test("any loaded account shows the full switcher regardless of a lingering note", () => {
  expect(accountSwitchView([account], "")).toBe("switch");
  expect(accountSwitchView([account], "Device login opened in codex-login")).toBe("switch");
});

test("account selector exposes only a pending device challenge", () => {
  expect(pendingDeviceAuth([
    { id: "default", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: { url: "https://auth.openai.com/hidden", code: "HIDE-ME" } },
    { id: "work", label: "Work", authPresent: false, loginPending: true, loginState: "pending", deviceAuth: { url: "https://auth.openai.com/codex/device", code: "ABCD-1234" } },
  ])).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-1234" });
});
