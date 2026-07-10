import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_SCAFFOLD_LENGTH, saveRoleOverrides } from "@/lib/roles/store";

import { pipelineRoleLookup, resolvePipelineRole } from "./roles";

const REGISTRY_LOOKUP = (roleId: string) => {
  if (roleId === "builder") return { engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "Builder guidance" };
  if (roleId === "reviewer") return { engine: "codex" as const, model: "gpt-5.6-sol", effort: "xhigh", access: "read-only" as const, promptScaffold: "Reviewer guidance" };
  return null;
};

test("role references resolve registry defaults and stage overrides", () => {
  const lookup = () => ({
    engine: "codex" as const,
    model: "terra",
    effort: "high",
    access: "read-write" as const,
    promptScaffold: "Builder guidance",
  });
  expect(resolvePipelineRole({
    role: { roleId: "builder" },
    engine: "claude",
    model: "opus",
    effort: "low",
    access: "read-only",
  }, "run", lookup).role).toEqual({
    roleId: "builder",
    engine: "claude",
    model: "opus",
    effort: "low",
    access: "read-only",
    promptScaffold: "Builder guidance",
  });
});

test("role-less stages inherit Builder runtime defaults and receive no scaffold", () => {
  const lookup = (roleId: string) => roleId === "builder"
    ? { engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "Builder guidance" }
    : null;
  expect(resolvePipelineRole({}, "run", lookup).role).toEqual({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    access: "read-write",
    promptScaffold: null,
  });
});

test("role resolution fails closed when the Builder preset is unavailable", () => {
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "high", access: "read-only" }, "run", null).error)
    .toBe("Builder role is unavailable in the role registry");
});

test("production role lookup reads the shared Builder preset", () => {
  expect(resolvePipelineRole({}, "run", pipelineRoleLookup).role).toMatchObject({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    access: "read-write",
    promptScaffold: null,
  });
});

test("stage runtime fields override registry and global defaults", () => {
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "xhigh", access: "read-only" }, "run", REGISTRY_LOOKUP).role).toEqual({
    roleId: null,
    engine: "claude",
    model: "opus",
    effort: "xhigh",
    access: "read-only",
    promptScaffold: null,
  });
  expect(resolvePipelineRole({ role: { roleId: "builder" } }, "run", REGISTRY_LOOKUP).role).toMatchObject({
    roleId: "builder",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
  });
});

test("cross-engine overrides require a compatible model", () => {
  expect(resolvePipelineRole({ role: { roleId: "reviewer" }, engine: "claude" }, "review-loop", REGISTRY_LOOKUP).error)
    .toContain("model is not supported by claude");
  expect(resolvePipelineRole({ engine: "claude" }, "run", REGISTRY_LOOKUP).error)
    .toContain("model is not supported by claude");
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "high" }, "run", REGISTRY_LOOKUP).role)
    .toMatchObject({ engine: "claude", model: "opus", effort: "high" });
});

test("review-loop roles default to read-only access", () => {
  expect(resolvePipelineRole({ role: { roleId: "reviewer" } }, "review-loop", REGISTRY_LOOKUP).role?.access).toBe("read-only");
  expect(resolvePipelineRole({ role: { roleId: "reviewer" }, access: "read-write" }, "review-loop", REGISTRY_LOOKUP).error).toBe("review-loop stages require read-only access");
});

test("role references stay inside the eight-role registry", () => {
  expect(resolvePipelineRole({ role: { roleId: "implementer" } } as never, "run", null).error).toBe("unknown pipeline role: implementer");
});

test("a near-limit override scaffold composes with fences inside the store cap", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-roles-cap-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    saveRoleOverrides({ reviewer: { promptScaffold: "x".repeat(MAX_SCAFFOLD_LENGTH) } });
    const resolved = pipelineRoleLookup("reviewer");
    expect(resolved?.promptScaffold?.length).toBeLessThanOrEqual(MAX_SCAFFOLD_LENGTH);
    expect(resolved?.promptScaffold).toContain("Safety fences:");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a referenced role with an empty scaffold fails the create instead of persisting", () => {
  const lookup = (roleId: string) => roleId === "builder"
    ? { engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "   " }
    : null;
  expect(resolvePipelineRole({ role: { roleId: "builder" } }, "run", lookup).error)
    .toContain("empty prompt scaffold");
});
