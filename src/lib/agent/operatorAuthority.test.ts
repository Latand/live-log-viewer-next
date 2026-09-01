import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { ensureOperatorSpawnCapability } from "./operatorCapability";
import {
  directOperatorActivityAuthority,
  internalServiceHeaders,
  requireOperatorAuthority,
  rotationActor,
  setCallerConversationResolverForTests,
  voiceTransportOperator,
} from "./operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./spawnPolicy";

/**
 * ONE QUESTION: agent, or operator?
 *
 * Authority used to be POSSESSION of an operator session secret, and these cases
 * enumerated the forgeries it refused. The operator rejected that mechanism after
 * using it: a tab that had not been through the paste gate could neither open the
 * manager nor start a call from a card, and every reload put it back there. So the
 * possession question is gone and the agent question is all that is left — a
 * same-origin request on this loopback single-user app IS the operator, and an
 * agent is the caller that names itself with the conversation capability the
 * registry issued it.
 *
 * The perimeter is `rejectCrossOrigin`, enforced by the routes BEFORE they reach
 * here; injection into a live call is decided by `permitRealtimeAction` and is not
 * relaxed by anything in this file.
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
  return new NextRequest("http://127.0.0.1/api/orchestrator/seat", { method: "POST", headers });
}

/** What an ordinary tab's fetch actually looks like on the wire. */
const BROWSER = {
  host: "127.0.0.1",
  origin: "http://127.0.0.1",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

test("REGRESSION: an ordinary browser request — nothing presented — may perform operator-only actions", () => {
  /* The rejected build answered `false` here, which is what made one-click
     designation impossible in a fresh tab. */
  expect(requireOperatorAuthority(request(BROWSER)).ok).toBe(true);
  expect(requireOperatorAuthority(request({ host: "127.0.0.1" })).ok).toBe(true);
});

test("an agent naming itself with its capability is refused, whatever else it sends", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");

  for (const headers of [
    { [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability },
    { ...BROWSER, [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability },
  ]) {
    const verdict = requireOperatorAuthority(request(headers));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.status).toBe(403);
      expect(verdict.error).toContain("agent");
    }
  }
});

test("a capability the registry cannot map is not an agent, and is not demoted below anonymous", () => {
  /* A stale value from an older process, or a guess: it names no conversation, so
     it names no agent. Presenting yesterday's value must not be worse than
     presenting nothing. */
  for (const candidate of ["", "  ", "short", "x".repeat(200), crypto.randomBytes(32).toString("base64url")]) {
    expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: candidate })).ok).toBe(true);
  }
});

test("the on-disk spawn capability names no conversation, so it neither grants nor refuses", () => {
  const onDisk = ensureOperatorSpawnCapability();
  expect(onDisk).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(requireOperatorAuthority(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: onDisk })).ok).toBe(true);
});

/* --------------------------------------------------------------------------- *
 * Voice transport asks the identical question — the two are one rule now.
 * --------------------------------------------------------------------------- */

test("REGRESSION: a card's voice click, presenting nothing, IS the operator", () => {
  expect(voiceTransportOperator(request({ host: "127.0.0.1" }))).toBe(true);
  expect(voiceTransportOperator(request(BROWSER))).toBe(true);
});

test("voice transport: an agent naming itself with its capability is refused", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");
  expect(voiceTransportOperator(request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability }))).toBe(false);
});

test("transport and operator-only actions agree: one rule, asked twice", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");
  const agent = request({ [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability });
  expect(voiceTransportOperator(agent)).toBe(false);
  expect(requireOperatorAuthority(agent).ok).toBe(false);

  setCallerConversationResolverForTests(() => null);
  const browser = request(BROWSER);
  expect(voiceTransportOperator(browser)).toBe(true);
  expect(requireOperatorAuthority(browser).ok).toBe(true);
});

test("direct activity accepts a browser and rejects server-authenticated background producers", () => {
  expect(directOperatorActivityAuthority(request(BROWSER)).ok).toBe(true);

  for (const service of ["monitor", "mcp", "orchestrator"] as const) {
    const serviceRequest = request({ ...BROWSER, ...internalServiceHeaders(service) });
    expect(directOperatorActivityAuthority(serviceRequest).ok).toBe(false);
    /* Service provenance only classifies WakaTime activity. It does not alter
       the product's existing operator-authority contract. */
    expect(requireOperatorAuthority(serviceRequest).ok).toBe(true);
  }
});

/* --------------------------------------------------------------------------- *
 * Rotation asks the same question and answers it with a NAME (#1402).
 * --------------------------------------------------------------------------- */

test("REGRESSION (#1402): rotation NAMES every caller and refuses none — the agent it used to reject included", () => {
  const workerCapability = crypto.randomBytes(32).toString("base64url");
  setCallerConversationResolverForTests(() => "conversation_worker");

  /* The self-named agent: refused for every operator-only action, and named
     for rotation. There is no other answer this function can give. */
  const agent = request({ ...BROWSER, [VIEWER_SPAWN_CAPABILITY_HEADER]: workerCapability });
  expect(requireOperatorAuthority(agent).ok).toBe(false);
  expect(rotationActor(agent)).toEqual({ kind: "agent", conversationId: "conversation_worker" });

  /* The operator's own tab names no conversation, and carries the `operator`
     label to say so. */
  setCallerConversationResolverForTests(() => null);
  expect(rotationActor(request(BROWSER))).toEqual({ kind: "operator", conversationId: null });
  /* A background lane's marker classifies activity and has never been an actor
     rule; rotation reads the same thing here as it does without it. */
  expect(rotationActor(request({ ...BROWSER, ...internalServiceHeaders("mcp") })))
    .toEqual({ kind: "operator", conversationId: null });
});

test("an invalid internal-service claim cannot impersonate authenticated background provenance", () => {
  expect(directOperatorActivityAuthority(request({
    ...BROWSER,
    "x-llv-internal-service": "mcp.invalid",
  })).ok).toBe(true);
});
