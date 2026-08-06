import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import { partitionCrownedSummaries } from "@/components/projectModel";

import {
  createManualProject,
  projectCurationSnapshot,
  resetProjectCurationForTests,
  setProjectCrown,
} from "./curation";
import { projectIdentityFromDirectory, projectIdentityFromRepositoryRoot } from "./identity";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-curation-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetProjectCurationForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("crowns persist across a server restart and uncrown removes them", () => {
  expect(setProjectCrown("repo-0123456789abcdef0123456789abcdef", true)).toBe(true);
  expect(setProjectCrown("dir-fedcba9876543210fedcba9876543210", true)).toBe(true);
  /* Re-crowning is idempotent: no duplicate entry, still a successful call. */
  expect(setProjectCrown("repo-0123456789abcdef0123456789abcdef", true)).toBe(true);

  /* A restart drops the in-memory cache; the file is the durable state. */
  resetProjectCurationForTests();
  expect(projectCurationSnapshot().crowned).toEqual([
    "repo-0123456789abcdef0123456789abcdef",
    "dir-fedcba9876543210fedcba9876543210",
  ]);

  expect(setProjectCrown("repo-0123456789abcdef0123456789abcdef", false)).toBe(true);
  resetProjectCurationForTests();
  expect(projectCurationSnapshot().crowned).toEqual(["dir-fedcba9876543210fedcba9876543210"]);
});

test("crowned rows float in their own pinned section without reordering either half", () => {
  const rows = [
    { project: "attention-project" },
    { project: "live-project" },
    { project: "recent-project" },
    { project: "older-project" },
  ];
  const { crowned, rest } = partitionCrownedSummaries(rows, new Set(["recent-project", "attention-project"]));
  /* Pinned keeps the shared order (attention first, then recency) — crowning
     never invents a different recency rule. */
  expect(crowned.map((row) => row.project)).toEqual(["attention-project", "recent-project"]);
  expect(rest.map((row) => row.project)).toEqual(["live-project", "older-project"]);
});

test("manual creation mints the scanner's identity for a plain directory", () => {
  const root = path.join(SANDBOX, "plain-folder");
  fs.mkdirSync(root, { recursive: true });
  const created = createManualProject("  My Notes  ", root);
  if (!created.ok) throw new Error(`expected creation, got ${created.code}`);
  /* Sessions later spawned in this directory resolve to the same project id,
     so they group under the manual project with no extra mapping. */
  expect(created.entry.project).toBe(projectIdentityFromDirectory(root)!.project);
  expect(created.entry.displayName).toBe("My Notes");
  expect(created.entry.root).toBe(fs.realpathSync.native(root));

  resetProjectCurationForTests();
  expect(projectCurationSnapshot().manualProjects).toEqual([created.entry]);
});

test("a directory inside a git checkout resolves to the repository identity and root", () => {
  const repo = path.join(SANDBOX, "checkout");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = git@example.com:team/checkout.git\n',
  );
  const nested = path.join(repo, "packages", "web");
  fs.mkdirSync(nested, { recursive: true });

  const created = createManualProject("Checkout", nested);
  if (!created.ok) throw new Error(`expected creation, got ${created.code}`);
  expect(created.entry.project).toBe(projectIdentityFromRepositoryRoot(repo)!.project);
  expect(created.entry.root).toBe(repo);
});

test("duplicate identities are refused, in the store and against the visible catalog", () => {
  const root = path.join(SANDBOX, "dup-folder");
  fs.mkdirSync(root, { recursive: true });
  const first = createManualProject("First", root);
  if (!first.ok) throw new Error(`expected creation, got ${first.code}`);

  const again = createManualProject("Second", root);
  expect(again).toEqual({ ok: false, code: "DUPLICATE_PROJECT", message: expect.any(String) });

  const other = path.join(SANDBOX, "other-folder");
  fs.mkdirSync(other, { recursive: true });
  const catalogId = projectIdentityFromDirectory(other)!.project;
  const clash = createManualProject("Other", other, new Set([catalogId]));
  expect(clash).toEqual({ ok: false, code: "DUPLICATE_PROJECT", message: expect.any(String) });

  resetProjectCurationForTests();
  expect(projectCurationSnapshot().manualProjects).toHaveLength(1);
});

test("invalid inputs are refused without touching the store", () => {
  expect(createManualProject("", path.join(SANDBOX, "plain-folder"))).toMatchObject({ ok: false, code: "INVALID_NAME" });
  expect(createManualProject("Name", "relative/path")).toMatchObject({ ok: false, code: "INVALID_ROOT" });
  expect(createManualProject("Name", path.join(SANDBOX, "missing-folder"))).toMatchObject({ ok: false, code: "INVALID_ROOT" });
  const file = path.join(SANDBOX, "a-file");
  fs.writeFileSync(file, "not a directory\n");
  expect(createManualProject("Name", file)).toMatchObject({ ok: false, code: "INVALID_ROOT" });
  expect(projectCurationSnapshot().manualProjects).toEqual([]);
});
