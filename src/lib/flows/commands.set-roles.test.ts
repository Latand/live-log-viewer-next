import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-set-roles-"));
const { patchFlow } = await import("./commands");
const { loadFlows, saveFlows } = await import("./store");
import type { Flow } from "./types";

function seed(overrides: Partial<Flow> = {}): Flow {
  const flow: Flow = {
    id: "f1",
    template: "implement-review-loop",
    project: "viewer",
    cwd: "/repo",
    implementerPath: "/impl",
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6", effort: "medium" },
      reviewer: { engine: "codex", model: "gpt-5.6", effort: "high" },
    },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "needs_decision",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
  saveFlows([flow]);
  return flow;
}

test("set-roles re-configures the reviewer for the next round and persists", () => {
  seed();
  const result = patchFlow("f1", { action: "set-roles", roles: { reviewer: { model: "fable", effort: "" } } });
  expect(result.error).toBeUndefined();
  expect(result.flow!.roles.reviewer).toEqual({ engine: "codex", model: "fable", effort: null });
  /* Implementer is untouched, and the change is written to the store. */
  expect(result.flow!.roles.implementer).toEqual({ engine: "codex", model: "gpt-5.6", effort: "medium" });
  expect(loadFlows()[0]!.roles.reviewer.model).toBe("fable");
});

test("set-roles can reseat the engine of both roles at once", () => {
  seed();
  const result = patchFlow("f1", {
    action: "set-roles",
    roles: { implementer: { engine: "claude", model: "opus" }, reviewer: { engine: "claude", model: "fable" } },
  });
  expect(result.flow!.roles.implementer).toMatchObject({ engine: "claude", model: "opus" });
  expect(result.flow!.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
});

test("set-roles rejects an invalid override and an empty payload", () => {
  seed();
  expect(patchFlow("f1", { action: "set-roles", roles: { reviewer: { engine: "gemini" as never } } }).status).toBe(400);
  expect(patchFlow("f1", { action: "set-roles", roles: {} }).status).toBe(400);
  expect(patchFlow("f1", { action: "set-roles" }).status).toBe(400);
});

test("set-roles refuses a closed flow", () => {
  seed({ state: "closed", closedAt: "2026-07-06T00:00:00Z" });
  expect(patchFlow("f1", { action: "set-roles", roles: { reviewer: { model: "fable" } } }).status).toBe(409);
});
