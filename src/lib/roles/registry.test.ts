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
    orchestrator: { engine: "claude", model: "opus", effort: "high" },
    reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    verifier: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    builder: { engine: "codex", model: "gpt-5.6-sol", effort: "medium" },
    architect: { engine: "claude", model: "opus", effort: "high" },
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
  expect(orchestrator.ok && orchestrator.value.config).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Viewer MCP tools");
  expect(orchestrator.ok && orchestrator.value.prompt).not.toMatch(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d+/);
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Repository: Latand/live-log-viewer-next");
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Issue query: is:open");
  expect(orchestrator.ok && orchestrator.value.prompt).toContain("Urgent list: #35");

  const standard = resolveRole("orchestrator");
  expect(standard.ok && standard.value.prompt).not.toContain("Repository:");
  expect(standard.ok && standard.value.prompt).not.toContain("Issue query:");
  expect(standard.ok && standard.value.prompt).not.toContain("Urgent list:");

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
  /* #774: a rejection names the accepted alternatives, so the caller can
     self-correct instead of reading the registry source. */
  expect(resolveRole("reviewer", { lens: "all", unexpected: true })).toEqual({
    ok: false,
    error: "unknown role parameter: unexpected (reviewer accepts: diffSource, lens, mode, parallelN)",
  });
  expect(resolveRole("verifier", {})).toEqual({
    ok: false,
    error: "missing required role parameter: claims",
  });
  expect(resolveRole("no-such-role", {})).toEqual({
    ok: false,
    error: "unknown role: no-such-role (allowed: orchestrator, reviewer, verifier, builder, architect, cleaner, prod-auditor, deployer)",
  });
});

test("resolved prompts carry role safety fences and reject cross-engine inherited models", () => {
  const reviewer = resolveRole("reviewer", { diffSource: "origin/main...HEAD", lens: "all" });
  expect(reviewer.ok && reviewer.value.prompt).toContain("Read-only mode: edits, staging, commits, pushes, service restarts, and GitHub comments are prohibited.");
  expect(reviewer.ok && reviewer.value.prompt).toContain("actionable fix plan");
  expect(reviewer.ok && reviewer.value.prompt).toContain("No copy-paste code unless absolutely necessary.");
  expect(reviewer.ok && reviewer.value.prompt).toContain("Report the reviewed SHA.");
  expect(reviewer.ok && reviewer.value.prompt).toContain("State plainly when GitHub or DNS access was unavailable.");
  expect(reviewer.ok && reviewer.value.prompt).toContain("environmental note");
  expect(reviewer.ok && reviewer.value.prompt).toContain("bunx tsc --noEmit --incremental false");

  expect(resolveSpawnRole({ role: "builder", roleParams: { mode: "plain" }, engine: "claude" })).toEqual({
    ok: false,
    error: "model is required when overriding a role engine",
  });
});

/* #1428 — pipeline stages inherit the role scaffold, so one sentence here reaches
   every builder, reviewer and architect stage without each spec restating it. */
test("builder, reviewer and architect scaffolds send the seat to search prior conversations first", () => {
  const resolved = [
    resolveRole("builder", { mode: "plain" }),
    resolveRole("reviewer", { diffSource: "origin/main...HEAD", lens: "all" }),
    resolveRole("architect", { mode: "design" }),
  ];
  for (const role of resolved) {
    if (!role.ok) throw new Error(role.error);
    expect(role.value.prompt).toContain("search_transcripts");
    expect(role.value.prompt).toContain("conversation_messages");
    expect(role.value.prompt).toContain("solved before");
  }
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

test("spawn role resolution enumerates the selected engine catalog for an invalid explicit model", () => {
  expect(resolveSpawnRole({
    role: "builder",
    roleParams: { mode: "plain" },
    engine: "claude",
    model: "mythos-1",
  })).toEqual({
    ok: false,
    error: "invalid claude model id \"mythos-1\"; valid claude model ids: opus, fable, sonnet, haiku",
  });
});

test("orchestrator spawn defaults omitted maxWorkers to three and preserves explicit one", () => {
  const omitted = resolveSpawnRole({ role: "orchestrator" });
  if (!omitted.ok || !omitted.value) throw new Error("expected resolved orchestrator role");
  expect(omitted.value.scaffold).toContain("Maximum workers: 3");

  const explicit = resolveSpawnRole({ role: "orchestrator", roleParams: { maxWorkers: 1 } });
  if (!explicit.ok || !explicit.value) throw new Error("expected resolved orchestrator role");
  expect(explicit.value.scaffold).toContain("Maximum workers: 1");
});
