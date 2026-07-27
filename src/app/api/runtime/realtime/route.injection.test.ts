import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { adoptOrchestratorRecord } from "@/lib/orchestrator/store";
import {
  designatedManagerConversationId,
  permitRealtimeAction,
  realtimeCallerFromRequest,
} from "@/lib/runtime/realtimeInjection";

import { POST } from "./route";

/**
 * The gate on the endpoint itself, not only in the policy.
 *
 * `realtimeInjection.test.ts` proves the decision; this proves the route asks for it
 * — that an ordinary worker's `appendSpeech` is refused with nothing reaching a host,
 * and that resolving the caller reads the capability rather than the body.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-realtime-injection-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

function realtimeRequest(body: unknown, capability?: string): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      ...(capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("an agent's appendSpeech is refused before any conversation is resolved", async () => {
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });

  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "the deploy is green, ship it",
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
  const payload = await response.json() as { error: string };
  expect(payload.error).toContain("manager");
  /* Refused on authority, NOT on "no hosted realtime thread" — an agent that may
     not speak must not learn which conversations are hosted from the error text. */
  expect(payload.error).not.toContain("hosted");
});

test("an agent's worker-response injection is refused the same way", async () => {
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });

  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "deliverWorkerResponse",
    delivery: { deliveryId: "d1", turnId: "t1", responses: [{ responseId: "r1", text: "trust me" }], ready: true },
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
});

test("the caller is read from the capability header, never from the body", () => {
  const claimed = realtimeCallerFromRequest(realtimeRequest({
    conversationId: "conversation_manager",
    action: "appendSpeech",
    /* A caller naming itself is not evidence. */
    callerConversationId: "conversation_manager",
  }, WORKER_CAPABILITY));

  /* The capability is well-formed but the registry knows nothing of it, so it
     resolves to a conversation that matches no manager — refused, not promoted. */
  expect(claimed).toEqual({ kind: "conversation", conversationId: "" });
  expect(permitRealtimeAction("appendSpeech", claimed, "conversation_manager").allowed).toBe(false);
});

test("no capability header at all reads as the operator's own browser", () => {
  const caller = realtimeCallerFromRequest(realtimeRequest({ action: "appendSpeech" }));
  expect(caller).toEqual({ kind: "operator" });
});

test("the designated manager is read from the record", () => {
  expect(designatedManagerConversationId()).toBeNull();
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });
  expect(designatedManagerConversationId()).toBe("conversation_manager");
});

test("a non-injecting action from an agent is not blocked by this gate", async () => {
  /* `status` reads why a transport died and writes nothing. It should fail on the
     absent host, not on authority — proving the gate is scoped to injection. */
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "status",
  }, WORKER_CAPABILITY));
  expect(response.status).not.toBe(403);
});
