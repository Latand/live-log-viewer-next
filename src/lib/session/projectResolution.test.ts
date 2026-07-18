import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { normalizeProjectOwnership, validExplicitProject } from "@/lib/accounts/migration/contracts";
import { resolveProjectAttribution } from "./projectResolution";

/* Keep persisted-project and worktree-map reads sandboxed away from the
   developer's real state directory. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-resolution-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const LLV_PROJECT = "-agents-tools-live-log-viewer-next";
const LLV_WORKTREE_CWD = path.join(
  os.homedir(),
  ".agents",
  "tools",
  "live-log-viewer-next",
  ".claude",
  "worktrees",
  "pipeline-315-explicit-ownership",
);

function operatorOwnership(project: string) {
  return { project, source: "operator" as const, setAt: "2026-07-16T12:00:00.000Z", operationId: "launch-1" };
}

test("explicit conversation ownership outranks canonical cwd, profile hint, and fallback", () => {
  const attribution = resolveProjectAttribution({
    projectOwnership: operatorOwnership(LLV_PROJECT),
    cwd: os.homedir(),
    launchProfileProject: "latand",
    fallbackProject: "other",
  });
  expect(attribution).toMatchObject({ project: LLV_PROJECT, source: "ownership" });
});

test("ownership keeps the worktree evidence its cwd proves", () => {
  const attribution = resolveProjectAttribution({
    projectOwnership: operatorOwnership(LLV_PROJECT),
    cwd: LLV_WORKTREE_CWD,
  });
  expect(attribution).toEqual({
    project: LLV_PROJECT,
    worktree: "pipeline-315-explicit-ownership",
    source: "ownership",
  });
});

test("canonical worktree cwd identity outranks a selected-project launch hint", () => {
  const attribution = resolveProjectAttribution({
    cwd: LLV_WORKTREE_CWD,
    launchProfileProject: "latand",
    fallbackProject: "other",
  });
  expect(attribution).toEqual({
    project: LLV_PROJECT,
    worktree: "pipeline-315-explicit-ownership",
    source: "cwd",
  });
});

test("a launch-profile hint fills in when no cwd evidence exists", () => {
  const attribution = resolveProjectAttribution({
    cwd: "",
    launchProfileProject: "stikon-dispatcher",
    fallbackProject: "other",
  });
  expect(attribution).toEqual({ project: "stikon-dispatcher", source: "launch-profile" });
});

test("a legacy session with no metadata keeps its scanner fallback", () => {
  expect(resolveProjectAttribution({ fallbackProject: "codex" }))
    .toEqual({ project: "codex", source: "fallback" });
  expect(resolveProjectAttribution({})).toEqual({ project: null, source: null });
});

test("a source-project fallback names a cross-project lineage stub", () => {
  const attribution = resolveProjectAttribution({
    cwd: "",
    launchProfileProject: null,
    fallbackProject: LLV_PROJECT,
  });
  expect(attribution).toEqual({ project: LLV_PROJECT, source: "fallback" });
});

test("blank ownership records never blank the attribution", () => {
  const attribution = resolveProjectAttribution({
    projectOwnership: { project: "   ", source: "operator", setAt: "2026-07-16T12:00:00.000Z", operationId: "x" },
    launchProfileProject: "latand",
  });
  expect(attribution).toEqual({ project: "latand", source: "launch-profile" });
});

test("explicit project validation rejects ambiguous aliases", () => {
  expect(validExplicitProject(LLV_PROJECT)).toBe(LLV_PROJECT);
  expect(validExplicitProject("latand")).toBe("latand");
  expect(validExplicitProject("  latand  ")).toBe("latand");
  expect(validExplicitProject("")).toBeNull();
  expect(validExplicitProject("   ")).toBeNull();
  expect(validExplicitProject("has space")).toBeNull();
  expect(validExplicitProject("path/traversal")).toBeNull();
  expect(validExplicitProject("..")).toBeNull();
  expect(validExplicitProject(42)).toBeNull();
  expect(validExplicitProject("x".repeat(200))).toBeNull();
});

test("ownership normalization fails closed on malformed durable records", () => {
  const valid = operatorOwnership(LLV_PROJECT);
  expect(normalizeProjectOwnership(valid)).toEqual(valid);
  expect(normalizeProjectOwnership(null)).toBeNull();
  expect(normalizeProjectOwnership(undefined)).toBeNull();
  expect(normalizeProjectOwnership("latand")).toBeNull();
  expect(normalizeProjectOwnership({ ...valid, source: "scanner" })).toBeNull();
  expect(normalizeProjectOwnership({ ...valid, project: "" })).toBeNull();
  expect(normalizeProjectOwnership({ project: LLV_PROJECT, source: "relocation" }))
    .toEqual({ project: LLV_PROJECT, source: "relocation", setAt: "1970-01-01T00:00:00.000Z", operationId: "" });
});
