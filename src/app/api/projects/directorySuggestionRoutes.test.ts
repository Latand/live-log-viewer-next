import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { resetProjectCurationForTests } from "@/lib/projects/curation";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-projects-routes-"));
const STATE = path.join(SANDBOX, "state");
const ANCHOR = path.join(SANDBOX, "anchor");
const CHECKOUT = path.join(ANCHOR, "checkout");
const SIBLING = path.join(ANCHOR, "sibling-idea");
const BEYOND = path.join(SANDBOX, "beyond", "unknown-area");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;

fs.mkdirSync(path.join(CHECKOUT, ".git"), { recursive: true });
fs.writeFileSync(path.join(CHECKOUT, ".git", "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(CHECKOUT, ".git", "config"), [
  '[remote "origin"]',
  "\turl = ssh://git@example.invalid/team/repository.git",
  "",
].join("\n"));
fs.mkdirSync(SIBLING, { recursive: true });
fs.mkdirSync(BEYOND, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(path.join(STATE, "project-catalog.json"), JSON.stringify({
  version: 2,
  resolutionVersion: 4,
  files: { fixture: { cwd: CHECKOUT, projectRoot: CHECKOUT } },
}));

process.env.LLV_STATE_DIR = STATE;
const { GET } = await import("./directories/route");
const { POST } = await import("./create/route");

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(path.join(STATE, "project-curation.json"), { force: true });
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

async function suggest(query: string): Promise<string[]> {
  const response = await GET(new NextRequest("http://127.0.0.1/api/projects/directories?q=" + encodeURIComponent(query)));
  const payload = await response.json() as { dirs: string[] };
  return payload.dirs;
}

async function create(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await POST(new NextRequest("http://127.0.0.1/api/projects/create", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:8898" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

test("/api/projects/directories completes inside the area a known project lives in", async () => {
  /* The anchor is the parent of the known checkout, so the directory beside it
     is a suggestion for a project that does not exist yet. */
  expect(await suggest(ANCHOR + "/")).toEqual([CHECKOUT, SIBLING]);
  expect(await suggest(path.join(ANCHOR, "sib"))).toEqual([SIBLING]);
});

test("/api/projects/directories never answers with a path outside the known roots", async () => {
  expect(await suggest(path.join(SANDBOX, "beyond") + "/")).toEqual([]);
  expect(await suggest("unknown-area")).toEqual([]);
});

test("/api/projects/create refuses a root outside the suggested roots and creates one inside them", async () => {
  const refused = await create({ name: "Beyond", root: BEYOND });
  expect(refused.status).toBe(400);
  expect(refused.payload.error).toBe("OUTSIDE_ROOTS");

  const relative = await create({ name: "Bare", root: "sibling-idea" });
  expect(relative.status).toBe(400);
  expect(relative.payload.error).toBe("RELATIVE_ROOT");

  const accepted = await create({ name: "Sibling Idea", root: SIBLING });
  expect(accepted.status).toBe(200);
  expect(accepted.payload.root).toBe(SIBLING);
});
