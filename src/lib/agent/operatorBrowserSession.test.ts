import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  establishOperatorBrowserSession,
  matchesOperatorBrowserSession,
  resetOperatorBrowserSessionsForTests,
} from "./operatorBrowserSession";

/**
 * The browser session's two load-bearing properties: it survives a server
 * restart (that is its whole reason to exist), and no usable bearer ever
 * touches disk while it does.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-browser-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  resetOperatorBrowserSessionsForTests();
});

afterEach(() => {
  resetOperatorBrowserSessionsForTests();
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function storeContents(): string {
  return fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "operator-browser-sessions.json"), "utf8");
}

test("an established token matches; a guessed one does not", () => {
  const token = establishOperatorBrowserSession();
  expect(matchesOperatorBrowserSession(token)).toBe(true);
  expect(matchesOperatorBrowserSession("")).toBe(false);
  expect(matchesOperatorBrowserSession("not-the-token")).toBe(false);
  expect(matchesOperatorBrowserSession(token.slice(0, -1))).toBe(false);
});

test("the session survives a server restart, which is its whole point", () => {
  const token = establishOperatorBrowserSession();
  /* A fresh process holds no memory; only the digest store on disk remains. */
  resetOperatorBrowserSessionsForTests();
  expect(matchesOperatorBrowserSession(token)).toBe(true);
});

test("the token itself is written to no file — only its digest is", () => {
  const token = establishOperatorBrowserSession();
  const persisted = storeContents();
  expect(persisted).not.toContain(token);
  expect(persisted).toMatch(/"digests"/);
  /* Exactly one 64-hex digest, which names the token without granting it. */
  expect(persisted.match(/[0-9a-f]{64}/g)).toHaveLength(1);
});

test("the population is bounded and the oldest session retires first", () => {
  const first = establishOperatorBrowserSession();
  let latest = first;
  for (let extra = 0; extra < 8; extra += 1) latest = establishOperatorBrowserSession();
  expect(matchesOperatorBrowserSession(first)).toBe(false);
  expect(matchesOperatorBrowserSession(latest)).toBe(true);
});

test("a corrupt store denies rather than throws", () => {
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "operator-browser-sessions.json"), "not json");
  expect(matchesOperatorBrowserSession("anything")).toBe(false);
  /* And establishing over it recovers the store. */
  const token = establishOperatorBrowserSession();
  expect(matchesOperatorBrowserSession(token)).toBe(true);
});
