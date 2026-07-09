import { expect, test } from "bun:test";

import { deviceAuthChallenge } from "./deviceAuth";

test("device-auth parser returns only the approved URL and one-time code", () => {
  const screen = "Open https://auth.openai.com/codex/device?flow=abc\nUser code: abcd-1234\ninternal path /home/me/.codex/auth.json";

  expect(deviceAuthChallenge(screen)).toEqual({ url: "https://auth.openai.com/codex/device?flow=abc", code: "ABCD-1234" });
});

test("device-auth parser refuses unrelated URLs and partial output", () => {
  expect(deviceAuthChallenge("Open https://example.com and use code ABCD-1234")).toBeNull();
  expect(deviceAuthChallenge("Open https://auth.openai.com/codex/device")).toBeNull();
});
