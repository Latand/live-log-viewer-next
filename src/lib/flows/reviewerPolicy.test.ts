import { expect, test } from "bun:test";

import type { AccountContext, HeadlessSpawnAvailability } from "@/lib/accounts/contracts";

import { chooseHeadlessReviewer, rateLimitStateDetail } from "./reviewerPolicy";
import type { RoleConfig } from "./types";

const codex: RoleConfig = { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" };
const fable: RoleConfig = { engine: "claude", model: "fable", effort: "high" };

function account(engine: "claude" | "codex", accountId: string): AccountContext {
  return { engine, accountId, kind: "managed", home: `/accounts/${accountId}`, transcriptRoot: `/accounts/${accountId}/sessions`, env: { NODE_ENV: "test" } };
}

test("headless reviewer falls back to the configured Fable role when Codex accounts are exhausted", () => {
  const resolve = (engine: "claude" | "codex"): HeadlessSpawnAvailability => engine === "codex"
    ? { kind: "exhausted", resetsAt: 1_800 }
    : { kind: "available", account: account("claude", "fable-main") };

  expect(chooseHeadlessReviewer(codex, fable, [], resolve)).toEqual({
    kind: "available",
    role: fable,
    account: account("claude", "fable-main"),
  });
});

test("headless retry chooses Fable before reusing its only failed Codex account", () => {
  const resolve = (engine: "claude" | "codex"): HeadlessSpawnAvailability => engine === "codex"
    ? { kind: "available", account: account("codex", "default") }
    : { kind: "available", account: account("claude", "fable-main") };

  expect(chooseHeadlessReviewer(codex, fable, ["codex:default"], resolve)).toEqual({
    kind: "available",
    role: fable,
    account: account("claude", "fable-main"),
  });
});

test("headless reviewer reports the earliest reset when primary and fallback accounts are exhausted", () => {
  const resolve = (engine: "claude" | "codex"): HeadlessSpawnAvailability => ({
    kind: "exhausted",
    resetsAt: engine === "codex" ? 1_800 : 900,
  });

  expect(chooseHeadlessReviewer(codex, fable, [], resolve)).toEqual({ kind: "exhausted", resetsAt: 900 });
  expect(rateLimitStateDetail(900)).toBe("reviewer rate limited; all accounts exhausted; resetsAt=1970-01-01T00:15:00.000Z");
});

test("headless reviewer keeps missing authentication distinct from quota exhaustion", () => {
  const resolve = (): HeadlessSpawnAvailability => ({ kind: "unavailable" });
  expect(chooseHeadlessReviewer(codex, fable, [], resolve)).toEqual({ kind: "unavailable" });
});
