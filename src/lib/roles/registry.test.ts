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
  expect(Object.fromEntries(roles.map((role) => [role.id, role.config]))).toEqual({
    orchestrator: { engine: "claude", model: "fable", effort: "high" },
    reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    verifier: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    builder: { engine: "codex", model: "gpt-5.6-sol", effort: "medium" },
    architect: { engine: "claude", model: "fable", effort: "high" },
    cleaner: { engine: "codex", model: "gpt-5.6-terra", effort: "low" },
    "prod-auditor": { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    deployer: { engine: "codex", model: "gpt-5.6-terra", effort: "medium" },
  });

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

  expect(resolveRole("builder", { mode: "plain", domain: "general" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-5.6-sol", effort: "medium" } },
  });
  expect(resolveRole("verifier", { claims: "the regression is fixed" })).toMatchObject({
    ok: true,
    value: { config: { engine: "codex", model: "gpt-5.6-sol", effort: "high" } },
  });
  expect(resolveRole("cleaner")).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-5.6-terra", effort: "low" } } });
  expect(resolveRole("deployer", { sha: "abc123" })).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-5.6-terra", effort: "medium" } } });
});

test("builder parameters select the cheap fixer and the frontend implementation profile", () => {
  const applyFixes = resolveRole("builder", { mode: "apply-fixes", domain: "general" });
  expect(applyFixes).toMatchObject({ ok: true, value: { config: { engine: "codex", model: "gpt-5.6-terra", effort: "low" } } });

  const frontend = resolveRole("builder", { mode: "plain", domain: "frontend" });
  expect(frontend).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "opus", effort: "high" } } });
  expect(frontend.ok && frontend.value.prompt).toContain("UI/frontend implementation guidance");
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
  expect(reviewer.ok && reviewer.value.prompt).toContain("actionable fix plan");
  expect(reviewer.ok && reviewer.value.prompt).toContain("No copy-paste code unless absolutely necessary.");

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
