import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";

import { createManualProject, resetProjectCurationForTests } from "./curation";
import { anchorForProjectRoot, suggestionRoots } from "./suggestionRoots";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-suggestion-roots-"));
const STATE = path.join(SANDBOX, "state");
/* `os.homedir()` is resolved once per process, so the fallback root is read
   from the runtime rather than pointed somewhere by this test. */
const HOME = os.homedir();
const SCANNED_ANCHOR = path.join(SANDBOX, "scanned-anchor");
const MANUAL_ANCHOR = path.join(SANDBOX, "manual-anchor");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;

function initializeRepository(repository: string): void {
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repository, ".git", "config"), [
    '[remote "origin"]',
    "\turl = ssh://git@example.invalid/team/repository.git",
    "",
  ].join("\n"));
}

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(STATE, { recursive: true, force: true });
  resetProjectCurationForTests();
  resetProjectDirectoryCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  resetProjectCurationForTests();
  resetProjectDirectoryCacheForTests();
});

test("the anchor of a project root is where its siblings live, and never the whole machine", () => {
  expect(anchorForProjectRoot("/team/repos/checkout")).toBe("/team/repos");
  /* A project directly under the filesystem root anchors on itself: `/` as a
     bound would mean the whole machine, which is what the bound refuses. */
  expect(anchorForProjectRoot("/checkout")).toBe("/checkout");
});

test("the roots are the home directory and the parents of the project roots the viewer knows", () => {
  const scanned = path.join(SCANNED_ANCHOR, "checkout");
  initializeRepository(scanned);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, "project-catalog.json"), JSON.stringify({
    version: 2,
    resolutionVersion: 4,
    files: { fixture: { cwd: scanned, projectRoot: scanned } },
  }));
  const manual = path.join(MANUAL_ANCHOR, "notes");
  fs.mkdirSync(manual, { recursive: true });
  const created = createManualProject("Notes", manual);
  if (!created.ok) throw new Error(`expected creation, got ${created.code}`);
  resetProjectDirectoryCacheForTests();

  const roots = suggestionRoots();
  expect(roots).toContain(SCANNED_ANCHOR);
  expect(roots).toContain(MANUAL_ANCHOR);
  expect(roots).toContain(HOME);
  /* Anchors lead: the home directory is the fallback, not the browse list. */
  expect(roots.indexOf(HOME)).toBe(roots.length - 1);
  expect(roots).not.toContain("/");
  expect(new Set(roots).size).toBe(roots.length);
});

test("with nothing known yet the home directory is still a root, so the picker is never empty", () => {
  expect(suggestionRoots()).toEqual([HOME]);
});
