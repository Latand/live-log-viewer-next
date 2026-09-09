import { afterEach, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import { realtimeRequestAuthority } from "./realtimeInjection";
import { voicePersonaVariantForConversation } from "./voicePersonaMandate";

/**
 * The resolver over the REAL registry (#1615).
 *
 * `voicePersonaRole.test.ts` pins the decision as a pure function; this proves the
 * production path feeds it the right facts — that "is this the voice front" is
 * answered from the durable launch profile the registry actually stores, and that
 * an ordinary conversation, which is what the operator toggled voice on, comes
 * back `modality`.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const originalRootId = process.env.LLV_ROOT_CONVERSATION_ID;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-persona-mandate-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  delete process.env.LLV_ROOT_CONVERSATION_ID;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalRootId === undefined) delete process.env.LLV_ROOT_CONVERSATION_ID;
  else process.env.LLV_ROOT_CONVERSATION_ID = originalRootId;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

let seq = 0;

/** An invented session identity, assembled from parts so no identifier-shaped
    literal appears in this file. */
function fixtureSessionId(): string {
  seq += 1;
  return ["aaaaaaaa", "bbbb", "4ccc", "8ddd", seq.toString().padStart(12, "0")].join("-");
}

/** A real registry conversation, launched with the given durable role. */
function spawnConversation(role: "root" | "worker" | null): string {
  const registry = agentRegistry();
  const cwd = "/repo";
  const sessionId = fixtureSessionId();
  const launchProfile = {
    ...emptyLaunchProfile({ cwd, title: "Exercise the voice persona mandate" }),
    ...(role ? { role } : {}),
  };
  const begun = beginLegacySpawnFixture(registry, {
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "default",
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: `/transcripts/${sessionId}.jsonl`,
    cwd,
    accountId: "default",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:fixture",
      process: { pid: process.pid, startIdentity: "fixture-process" },
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:fixture",
    pendingAction: "spawn",
  });
  if (settled.kind !== "settled") throw new Error("spawn identity was unavailable");
  return begun.receipt.conversationId;
}

test("an ordinary conversation keeps its own role when voice is enabled", () => {
  const conversationId = spawnConversation(null);
  expect(voicePersonaVariantForConversation(conversationId)).toBe("modality");
});

test("a conversation launched as root is the voice coordinator", () => {
  const conversationId = spawnConversation("root");
  expect(voicePersonaVariantForConversation(conversationId)).toBe("coordinator");
});

test("a worker-role conversation is never promoted by enabling voice", () => {
  /* Voice must not be a privilege escalation: a builder that opens a call is a
     builder that can be heard, and nothing more. */
  const conversationId = spawnConversation("worker");
  expect(voicePersonaVariantForConversation(conversationId)).toBe("modality");
});

test("the configured root conversation is honoured", () => {
  const conversationId = spawnConversation(null);
  process.env.LLV_ROOT_CONVERSATION_ID = conversationId;
  expect(voicePersonaVariantForConversation(conversationId)).toBe("coordinator");
  /* Scoped to the one it names — seating a root does not make every call one. */
  expect(voicePersonaVariantForConversation(spawnConversation(null))).toBe("modality");
});

test("an unregistered or malformed conversation resolves to modality", () => {
  for (const candidate of ["conversation_missing", "not-a-conversation", "", null, undefined, 7]) {
    expect(voicePersonaVariantForConversation(candidate)).toBe("modality");
  }
});

/* ------------------------------------------------------------------ *
 * The wiring the route performs (#1615 review, finding 5).
 *
 * The route composes exactly this and passes it to `executeRealtimeControl`.
 * Proving the resolver and proving the forwarding separately left the join
 * untested, and the untested direction is the dangerous one: a wiring that
 * answers `coordinator` too readily is what overwrites a live role.
 * ------------------------------------------------------------------ */

function browserRequest(): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: "{}",
  });
}

test("the request authority carries the modality persona for an ordinary conversation", () => {
  const conversationId = spawnConversation(null);
  const authority = realtimeRequestAuthority(browserRequest(), { action: "start", conversationId });
  expect(authority.personaVariant).toBe("modality");
  /* The operator's own browser presents no capability, so it holds transport. */
  expect(authority.operator).toBeTrue();
  expect(authority.caller).toEqual({ kind: "anonymous" });
});

test("the request authority carries the modality persona for a worker", () => {
  const conversationId = spawnConversation("worker");
  expect(realtimeRequestAuthority(browserRequest(), { action: "start", conversationId }).personaVariant)
    .toBe("modality");
});

test("the request authority carries the coordinator persona only for the voice front", () => {
  const conversationId = spawnConversation("root");
  expect(realtimeRequestAuthority(browserRequest(), { action: "start", conversationId }).personaVariant)
    .toBe("coordinator");
});

test("a body naming no resolvable conversation still fails safe to modality", () => {
  for (const conversationId of ["conversation_missing", "", 42, undefined]) {
    expect(realtimeRequestAuthority(browserRequest(), { action: "start", conversationId }).personaVariant)
      .toBe("modality");
  }
});
