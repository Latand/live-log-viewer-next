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
/* A link that is spelled inside the anchor and lands outside it — the one
   shape where suggestion and creation could disagree (issue #1223). */
const LINK = path.join(ANCHOR, "linked-projects");
/* $HOME is one of the roots this route suggests from, so it is pointed at the
   sandbox: left ambient, a bare-word query would read the operator's real home
   and let its contents decide these assertions. */
const HOME = path.join(SANDBOX, "home");
const HOME_IDEA = path.join(HOME, "home-side-idea");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const ORIGINAL_HOME = process.env.HOME;

fs.mkdirSync(HOME_IDEA, { recursive: true });
fs.mkdirSync(path.join(CHECKOUT, ".git"), { recursive: true });
fs.writeFileSync(path.join(CHECKOUT, ".git", "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(CHECKOUT, ".git", "config"), [
  '[remote "origin"]',
  "\turl = ssh://git@example.invalid/team/repository.git",
  "",
].join("\n"));
fs.mkdirSync(SIBLING, { recursive: true });
fs.mkdirSync(BEYOND, { recursive: true });
fs.symlinkSync(path.join(SANDBOX, "beyond"), LINK);
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(path.join(STATE, "project-catalog.json"), JSON.stringify({
  version: 2,
  resolutionVersion: 4,
  files: { fixture: { cwd: CHECKOUT, projectRoot: CHECKOUT } },
}));

process.env.LLV_STATE_DIR = STATE;
process.env.HOME = HOME;
const { GET } = await import("./directories/route");
const { POST } = await import("./create/route");

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  process.env.HOME = HOME;
  fs.rmSync(path.join(STATE, "project-curation.json"), { force: true });
  resetProjectCurationForTests();
  resetProjectDirectoryCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
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
     is a suggestion for a project that does not exist yet. The link that leads
     out of the anchor is not one: it is spelled inside the bound and lands
     outside it, which is precisely what create refuses. */
  expect(await suggest(ANCHOR + "/")).toEqual([CHECKOUT, SIBLING]);
  expect(await suggest(path.join(ANCHOR, "sib"))).toEqual([SIBLING]);
});

test("/api/projects/create accepts every directory /api/projects/directories offers", async () => {
  /* The refusal the operator cannot act on: a row picked out of the list, then
     rejected as outside the list's own roots (issue #1223). The two routes read
     one bound, so the answer to "choose one from the list" is always a path
     create takes. */
  expect(await suggest(LINK + "/")).toEqual([]);
  const suggestions = [...await suggest(""), ...await suggest(ANCHOR + "/")];
  expect(suggestions).not.toContain(LINK);
  expect(suggestions.length).toBeGreaterThan(0);
  for (const dir of suggestions) {
    const outcome = await create({ name: path.basename(dir), root: dir });
    expect(outcome.payload.error).not.toBe("OUTSIDE_ROOTS");
  }
});

test("/api/projects/directories never answers with a path outside the known roots", async () => {
  expect(await suggest(path.join(SANDBOX, "beyond") + "/")).toEqual([]);
  /* A bare word is a filter over what the roots hold, so a directory of that
     name outside them is not found — and no query reaches out of the sandbox
     at all, $HOME being a root of this route and pointed inside it. */
  expect(await suggest("unknown-area")).toEqual([]);
  for (const query of ["", ANCHOR + "/", "idea", "unknown-area"]) {
    for (const dir of await suggest(query)) expect(dir.startsWith(SANDBOX + path.sep)).toBe(true);
  }
});

test("/api/projects/directories falls back to the home directory the viewer is running under", async () => {
  /* The machine with no projects yet still gets a list, and it comes from the
     running viewer's $HOME rather than from whatever home the process was
     started in — which is what keeps an isolated runtime isolated. */
  expect(await suggest("home-side")).toEqual([HOME_IDEA]);
  expect(await suggest("")).toContain(HOME_IDEA);
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
