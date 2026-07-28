import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { ensureOperatorSpawnCapability, rotateOperatorSpawnCapability } from "./operatorCapability";
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
    expect(verdict.error).toContain("operator capability");
  }
});

test("no headers at all grant nothing", () => {
  expect(requireOperatorAuthority(request({ host: "127.0.0.1" })).ok).toBe(false);
});

test("the operator capability grants authority", () => {
  const capability = ensureOperatorSpawnCapability();
  expect(requireOperatorAuthority(request({ ...FORGED_BROWSER, [VIEWER_SPAWN_CAPABILITY_HEADER]: capability })).ok)
    .toBe(true);
  /* And without any browser-shaped headers at all, since shape is not the point. */
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: capability })).ok).toBe(true);
});

test("a rotated capability revokes the old one", () => {
  const stale = ensureOperatorSpawnCapability();
  const fresh = rotateOperatorSpawnCapability();
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
  ensureOperatorSpawnCapability();
  const guess = crypto.randomBytes(32).toString("base64url");
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: guess })).ok).toBe(false);
});

test("a malformed capability is refused without being looked up", () => {
  ensureOperatorSpawnCapability();
  for (const candidate of ["", "  ", "short", "x".repeat(200)]) {
    expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: candidate })).ok).toBe(false);
  }
});
