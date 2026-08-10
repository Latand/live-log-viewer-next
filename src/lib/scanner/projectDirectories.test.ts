import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";

import { projectForCwd } from "./describe";
import {
  projectDirectoryCandidates,
  projectDirectoryFallbacks,
  resetProjectDirectoryCacheForTests,
} from "./projectDirectories";

function initializeRepository(repository: string): void {
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = ssh://git@example.invalid/team/repository.git",
    "",
  ].join("\n"));
}

test("an unmatched task-only project has no fabricated home-directory fallback", () => {
  resetProjectDirectoryCacheForTests();
  const project = `missing-task-project-${process.pid}-${Date.now()}`;
  expect(projectDirectoryFallbacks([project])).toEqual({});
});

test("durable scanner state discovers repository roots under arbitrary parent directories", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-directories-"));
  const previousState = process.env.LLV_STATE_DIR;
  const state = path.join(sandbox, "state");
  const repository = path.join(sandbox, "arbitrary", "checkout");
  try {
    process.env.LLV_STATE_DIR = state;
    initializeRepository(repository);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "project-catalog.json"), JSON.stringify({
      version: 2,
      resolutionVersion: 4,
      files: {
        fixture: {
          cwd: repository,
          projectRoot: repository,
        },
      },
    }));
    resetProjectDirectoryCacheForTests();
    const project = projectForCwd(repository)!;

    expect(projectDirectoryCandidates(project)).toEqual([repository]);
    expect(projectDirectoryFallbacks([project])).toEqual({ [project]: repository });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
    resetProjectDirectoryCacheForTests();
  }
});

test("a cross-process SQLite flow commit refreshes warm project-directory suggestions", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-directories-sqlite-"));
  const previousState = process.env.LLV_STATE_DIR;
  const state = path.join(sandbox, "state");
  const first = path.join(sandbox, "repositories", "first");
  const second = path.join(sandbox, "repositories", "second");
  try {
    process.env.LLV_STATE_DIR = state;
    initializeRepository(first);
    initializeRepository(second);
    fs.mkdirSync(state, { recursive: true });
    const seed: Flow = {
      id: "directory-seed",
      template: "implement-review-loop",
      project: projectForCwd(first)!,
      cwd: first,
      implementerPath: "/directory-seed.jsonl",
      roles: {
        implementer: { engine: "codex", model: null, effort: "medium" },
        reviewer: { engine: "codex", model: null, effort: "xhigh" },
      },
      baseRef: "base",
      baseMode: "head",
      mode: "auto",
      reviewerMode: "headless",
      roundLimit: 3,
      state: "waiting_ready",
      stateDetail: null,
      rounds: [],
      createdAt: "2026-08-06T00:00:00.000Z",
      closedAt: null,
    };
    fs.writeFileSync(path.join(state, "flows.json"), JSON.stringify({ flows: [seed] }));
    loadFlows();
    resetProjectDirectoryCacheForTests();
    expect(projectDirectoryCandidates(projectForCwd(first)!)).toContain(first);

    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "projectDirectories.sqliteChild.ts"), second, "directory-external"],
      cwd: process.cwd(),
      env: { ...process.env, LLV_STATE_DIR: state },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await child.exited;
    if (exit !== 0) throw new Error(`project-directory writer failed: ${await new Response(child.stderr).text()}`);
    expect(projectDirectoryCandidates(projectForCwd(second)!)).toContain(second);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
    resetProjectDirectoryCacheForTests();
  }
});
