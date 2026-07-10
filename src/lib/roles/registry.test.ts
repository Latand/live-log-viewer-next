import { expect, test } from "bun:test";

import { listRoles, resolveRole, resolveSpawnRole } from "./registry";

test("role registry exposes the frozen eight role ids and campaign-ready orchestrator config", () => {
  const roles = listRoles();

  expect(roles.map((role) => role.id)).toEqual([
    "orchestrator",
    "reviewer",
    "verifier",
    "builder",
    "architect",
    "cleaner",
    "prod-auditor",
    "deployer",
  ]);

  const orchestrator = resolveRole("orchestrator", {
    mode: "backlog-campaign",
    repo: "Latand/live-log-viewer-next",
    issueQuery: "is:open",
    urgent: "#35",
    maxWorkers: 2,
    mergePolicy: "pr",
    completionPolicy: "released",
  });
  expect(orchestrator.ok && orchestrator.value.config).toEqual({ engine: "claude", model: "fable", effort: "high" });
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("127.0.0.1:8898");
});

test("role registry rejects unknown and missing required parameters with bounded errors", () => {
  expect(resolveRole("reviewer", { lens: "all", unexpected: true })).toEqual({
    ok: false,
    error: "unknown role parameter: unexpected",
  });
  expect(resolveRole("verifier", {})).toEqual({
    ok: false,
    error: "missing required role parameter: claims",
  });
});

test("resolved prompts carry role safety fences and reject cross-engine inherited models", () => {
  const reviewer = resolveRole("reviewer", { diffSource: "origin/main...HEAD", lens: "all" });
  expect(reviewer.ok && reviewer.value.prompt).toContain("Read-only mode: edits, staging, commits, pushes, service restarts, and GitHub comments are prohibited.");

  expect(resolveSpawnRole({ role: "builder", roleParams: { mode: "plain" }, engine: "claude" })).toEqual({
    ok: false,
    error: "model is required when overriding a role engine",
  });
});

test("deployer requires confirmation while explicit spawn fields can override its profile", () => {
  const unresolved = resolveRole("deployer", { sha: "abc123" });
  expect(unresolved.ok && unresolved.value.requiresDeploymentConfirmation).toBe(true);

  const resolved = resolveRole("deployer", { sha: "abc123" }, {
    engine: "claude",
    model: "opus",
    effort: "high",
  });
  expect(resolved.ok && resolved.value.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
});

test("spawn role resolution injects the scaffold and requires deploy confirmation", () => {
  const missingConfirmation = resolveSpawnRole({ role: "deployer", roleParams: { sha: "abc123" } });
  expect(missingConfirmation).toEqual({ ok: false, error: "deployer requires confirm: deploy" });

  const spawn = resolveSpawnRole({
    role: "builder",
    roleParams: { mode: "tdd" },
    engine: "claude",
    model: "opus",
    effort: "high",
  });
  if (!spawn.ok || !spawn.value) throw new Error("expected resolved builder role");
  expect(spawn.value.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(spawn.value.scaffold).toContain("Builder in tdd mode");
});
