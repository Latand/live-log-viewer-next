import { expect, test } from "bun:test";

import { resolvePipelineRole } from "./roles";

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
  const lookup = () => ({ engine: "claude" as const, model: "fable", effort: "xhigh", promptScaffold: "Role guidance" });
  expect(resolvePipelineRole({}, "run", lookup).role).toEqual({
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    access: "read-write",
    promptScaffold: null,
  });
});

test("stage runtime fields override registry and global defaults", () => {
  expect(resolvePipelineRole({ engine: "claude", model: "opus", effort: "xhigh", access: "read-only" }, "run", null).role).toEqual({
    roleId: null,
    engine: "claude",
    model: "opus",
    effort: "xhigh",
    access: "read-only",
    promptScaffold: null,
  });
  expect(resolvePipelineRole({ role: { roleId: "builder" } }, "run", null).role).toMatchObject({
    roleId: "builder",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
});

test("review-loop roles default to read-only access", () => {
  expect(resolvePipelineRole({ role: { roleId: "reviewer" } }, "review-loop", null).role?.access).toBe("read-only");
  expect(resolvePipelineRole({ role: { roleId: "reviewer" }, access: "read-write" }, "review-loop", null).error).toBe("review-loop stages require read-only access");
});

test("role references stay inside the eight-role registry", () => {
  expect(resolvePipelineRole({ role: { roleId: "implementer" } } as never, "run", null).error).toBe("unknown pipeline role: implementer");
});
