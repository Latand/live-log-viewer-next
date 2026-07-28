import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import {
  establishOperatorBrowserSession,
  OPERATOR_SESSION_COOKIE,
  resetOperatorBrowserSessionsForTests,
} from "./operatorBrowserSession";
import { ensureOperatorSpawnCapability, operatorSpawnCapabilityPath } from "./operatorCapability";
import { operatorSessionSecret, resetOperatorSessionForTests } from "./operatorSession";
import { requireOperatorAuthority, setCallerConversationResolverForTests } from "./operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./spawnPolicy";

/**
 * Authority is possession, not request shape.
 *
 * The first version of this primitive accepted `sec-fetch-site: same-origin` with a
 * matching `Origin`/`Host`. A forbidden header name is forbidden to page JavaScript,
 * not to a local process, so any worker could omit its own capability, write those
 * three headers, and inherit the right to appoint itself the manager. Every gate in
 * this feature resolves here, so these enumerate the forgeries.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-authority-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  resetOperatorBrowserSessionsForTests();
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/orchestrator", { method: "POST", headers });
}

/** Exactly what a local process can write, and what used to be believed. */
const FORGED_BROWSER = {
  host: "127.0.0.1",
  origin: "http://127.0.0.1",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

test("forged same-origin headers grant nothing", () => {
  const verdict = requireOperatorAuthority(request(FORGED_BROWSER));
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) {
    expect(verdict.status).toBe(403);
    expect(verdict.error).toContain("operator session secret");
  }
});

test("no headers at all grant nothing", () => {
  expect(requireOperatorAuthority(request({ host: "127.0.0.1" })).ok).toBe(false);
});

test("the in-memory operator session secret grants authority", () => {
  const capability = operatorSessionSecret();
  expect(requireOperatorAuthority(request({ ...FORGED_BROWSER, [VIEWER_SPAWN_CAPABILITY_HEADER]: capability })).ok)
    .toBe(true);
  /* And without any browser-shaped headers at all, since shape is not the point. */
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: capability })).ok).toBe(true);
});

test("a restarted process revokes the old secret", () => {
  const stale = operatorSessionSecret();
  const fresh = (resetOperatorSessionForTests(), operatorSessionSecret());
  expect(stale).not.toBe(fresh);
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: stale })).ok).toBe(false);
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: fresh })).ok).toBe(true);
});

test("a worker's own capability is refused, even alongside forged browser headers", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");

  const verdict = requireOperatorAuthority(request({
    ...FORGED_BROWSER,
    [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability,
  }));
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.error).toContain("agent");
});

test("a guessed capability of the right shape is refused", () => {
  operatorSessionSecret();
  const guess = crypto.randomBytes(32).toString("base64url");
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: guess })).ok).toBe(false);
});

test("a malformed capability is refused without being looked up", () => {
  operatorSessionSecret();
  for (const candidate of ["", "  ", "short", "x".repeat(200)]) {
    expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: candidate })).ok).toBe(false);
  }
});

test("the on-disk spawn capability does NOT grant operator authority", () => {
  /* The fourth way in: every worker runs as the operator's uid, so a file the Viewer
     can read is a file every worker can read. Authority moved off the filesystem
     entirely, and this holds that line. */
  const onDisk = ensureOperatorSpawnCapability();
  expect(onDisk).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: onDisk })).ok).toBe(false);

  /* And the real secret is not the file's contents, so reading the file tells a
     worker nothing about it. */
  expect(operatorSessionSecret()).not.toBe(onDisk);
  expect(fs.readFileSync(operatorSpawnCapabilityPath(), "utf8")).not.toContain(operatorSessionSecret());
});

test("the session secret is written to no file under the state dir", () => {
  const sessionValue = operatorSessionSecret();
  const root = process.env.LLV_STATE_DIR!;
  fs.mkdirSync(root, { recursive: true });
  ensureOperatorSpawnCapability();

  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
  for (const file of walk(root)) {
    expect(fs.readFileSync(file, "utf8")).not.toContain(sessionValue);
  }
});

/* --------------------------------------------------------------------------- *
 * The browser session cookie — possession in a place page JS cannot read and a
 * local process cannot write (`operatorBrowserSession.ts`).
 * --------------------------------------------------------------------------- */

test("an established browser-session cookie grants authority, with no header at all", () => {
  const token = establishOperatorBrowserSession();
  expect(requireOperatorAuthority(request({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}` })).ok).toBe(true);
  /* Alongside other cookies and forged browser shape, exactly as a real request. */
  expect(requireOperatorAuthority(request({
    ...FORGED_BROWSER,
    cookie: `theme=dark; ${OPERATOR_SESSION_COOKIE}=${token}; locale=uk`,
  })).ok).toBe(true);
});

test("a guessed or absent cookie grants nothing", () => {
  establishOperatorBrowserSession();
  expect(requireOperatorAuthority(request({ cookie: `${OPERATOR_SESSION_COOKIE}=guess-guess-guess` })).ok).toBe(false);
  expect(requireOperatorAuthority(request({ cookie: "theme=dark" })).ok).toBe(false);
});

test("the cookie survives a restart while the link secret does not", () => {
  const token = establishOperatorBrowserSession();
  const stale = operatorSessionSecret();
  /* The restart: fresh process memory, same state dir. */
  resetOperatorSessionForTests();
  resetOperatorBrowserSessionsForTests();
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: stale })).ok).toBe(false);
  expect(requireOperatorAuthority(request({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}` })).ok).toBe(true);
  /* A stale header riding beside the valid cookie must not block it — that IS
     the operator's tab after a stage refresh. */
  expect(requireOperatorAuthority(request({
    [VIEWER_SPAWN_CAPABILITY_HEADER]: stale,
    cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  })).ok).toBe(true);
});

test("an agent presenting its capability is refused even with a valid cookie", () => {
  const token = establishOperatorBrowserSession();
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");
  const verdict = requireOperatorAuthority(request({
    [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability,
    cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  }));
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.error).toContain("agent");
});
