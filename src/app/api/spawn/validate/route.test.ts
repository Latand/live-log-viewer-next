import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { AGENT_SPAWN_LINEAGE_ERROR } from "@/app/api/spawn/admission";
import { AgentRegistry } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { readSpawnAdmissionFence } from "@/lib/agent/spawnAdmission";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import type { RuntimeHostClient } from "@/lib/runtime/client";

import { POST as spawnPost } from "../route";
import { POST } from "./route";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-admission-validate-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
const previousStructuredHosts = process.env.LLV_STRUCTURED_HOSTS;
const previousRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const previousCodexBinary = process.env.LLV_CODEX_BINARY;
const codexBinary = path.join(sandbox, "codex-list");
fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_SPAWN_TRANSPORT = "structured";
process.env.LLV_STRUCTURED_HOSTS = "1";
process.env.LLV_RUNTIME_EVENTS = "1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_CODEX_BINARY = codexBinary;

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
  else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
  if (previousStructuredHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
  else process.env.LLV_STRUCTURED_HOSTS = previousStructuredHosts;
  if (previousRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = previousRuntimeEvents;
  if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
  else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function request(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/spawn/validate", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:8898",
      host: "127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function spawnRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/spawn", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:8898",
      host: "127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function spawnDependencies(store: AgentRegistry, cwd: string): Parameters<typeof spawnPost.withDependencies>[1] {
  const account = {
    engine: "codex" as const,
    accountId: "codex-test",
    kind: "managed" as const,
    home: path.join(cwd, "account"),
    transcriptRoot: path.join(cwd, "projects"),
    env: { NODE_ENV: "test" },
  };
  return {
    registry: () => store,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: () => {},
    storeImages: () => [],
    spawnStructuredConversation: async () => {
      throw new Error("spawn should stay behind the admission fence");
    },
  } as Parameters<typeof spawnPost.withDependencies>[1];
}

test("validation refusal writes an exact durable fence and blocks a later reservation", async () => {
  const cwd = path.join(sandbox, "launch-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const body = {
    title: "Recover a rejected deployer",
    role: "deployer",
    roleParams: { sha: "a".repeat(40), pr: "26" },
    cwd,
    ["prompt"]: "launch the dev deployer",
    clientAttemptId: "spawn_admission_fence_1",
  };

  const refusal = await POST.withDependencies(request(body), { registry: () => store });
  expect(refusal.status).toBe(200);
  expect(await refusal.json()).toEqual({
    admissible: false,
    fenced: true,
    reason: "deployer requires confirm: deploy",
    status: 400,
  });
  expect(readSpawnAdmissionFence(body.clientAttemptId)).toMatchObject({
    clientAttemptId: body.clientAttemptId,
    status: 400,
    error: "deployer requires confirm: deploy",
  });
  expect(store.spawnReceiptForClientAttempt(body.clientAttemptId)).toBeNull();

  /* The real route records the same fence on the post-wire 400 path. */
  const routeRefusal = await spawnPost.withDependencies(spawnRequest(body), {
    registry: () => store,
  } as Parameters<typeof spawnPost.withDependencies>[1]);
  expect(routeRefusal.status).toBe(400);

  /* A changed body cannot reuse the refusal, and the reservation is blocked
     before any launch receipt or deferred worker is created. */
  const changed = { ...body, confirm: "deploy" };
  const conflict = await spawnPost.withDependencies(
    spawnRequest(changed),
    spawnDependencies(store, cwd),
  );
  expect({ status: conflict.status, body: await conflict.json() }).toEqual({
    status: 409,
    body: { error: "spawn attempt conflicts with its original request" },
  });
  expect(store.spawnReceiptForClientAttempt(body.clientAttemptId)).toBeNull();
});

test("an admissible validation result leaves the key unfenced", async () => {
  const cwd = path.join(sandbox, "admissible-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_admission_admissible_1";
  const response = await POST.withDependencies(request({
    title: "Confirmed deployer",
    role: "deployer",
    roleParams: { sha: "b".repeat(40), pr: "26" },
    confirm: "deploy",
    cwd,
    ["prompt"]: "launch the dev deployer",
    clientAttemptId,
  }), { registry: () => store });

  expect(await response.json()).toEqual({ admissible: true, fenced: false });
  expect(readSpawnAdmissionFence(clientAttemptId)).toBeNull();
});

test("an unauthenticated agent refusal does not burn its downstream key", async () => {
  const cwd = path.join(sandbox, "unauthenticated-agent-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const body = {
    title: "Unauthenticated refused deployer",
    role: "deployer",
    roleParams: { sha: "d".repeat(40), pr: "26" },
    cwd,
    ["prompt"]: "launch the dev deployer",
    clientAttemptId: "spawn_admission_unauth_1",
  };

  const validation = await POST.withDependencies(request(body, { "sec-fetch-site": "none" }), { registry: () => store });
  expect(validation.status).toBe(403);
  expect(readSpawnAdmissionFence(body.clientAttemptId)).toBeNull();

  const route = await spawnPost.withDependencies(spawnRequest(body, { "sec-fetch-site": "none" }), {
    registry: () => store,
  } as Parameters<typeof spawnPost.withDependencies>[1]);
  expect(route.status).toBe(400);
  expect(await route.json()).toEqual({ error: "deployer requires confirm: deploy" });
  expect(readSpawnAdmissionFence(body.clientAttemptId)).toBeNull();
});

test("a malformed unrelated fence entry does not block a new refusal fence", async () => {
  const cwd = path.join(sandbox, "malformed-entry-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const fenceFile = path.join(process.env.LLV_STATE_DIR!, "spawn-admission-fences.json");
  fs.mkdirSync(path.dirname(fenceFile), { recursive: true });
  fs.writeFileSync(fenceFile, JSON.stringify({ version: 1, fences: {
    spawn_admission_malformed_1: null,
  } }) + "\n");
  expect(() => readSpawnAdmissionFence("spawn_admission_malformed_1")).toThrow("invalid spawn admission fence");
  const body = {
    title: "Refusal beside damaged history",
    role: "deployer",
    roleParams: { sha: "e".repeat(40), pr: "26" },
    cwd,
    ["prompt"]: "launch the dev deployer",
    clientAttemptId: "spawn_admission_recover_1",
  };

  const response = await POST.withDependencies(request(body), { registry: () => store });
  expect(await response.json()).toMatchObject({ admissible: false, fenced: true, status: 400 });
  expect(readSpawnAdmissionFence(body.clientAttemptId)).toMatchObject({ clientAttemptId: body.clientAttemptId });
});

test("an engine override refusal uses the same request-bound fence", async () => {
  const cwd = path.join(sandbox, "override-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_admission_override_1";
  const response = await POST.withDependencies(request({
    title: "Engine override refusal",
    role: "builder",
    engine: "claude",
    cwd,
    ["prompt"]: "exercise the override refusal",
    clientAttemptId,
  }), { registry: () => store });

  expect(await response.json()).toEqual({
    admissible: false,
    fenced: true,
    reason: "model is required when overriding a role engine",
    status: 400,
  });
  expect(readSpawnAdmissionFence(clientAttemptId)).toMatchObject({ status: 400 });
});

test("an existing downstream launch wins over a validation refusal", async () => {
  const cwd = path.join(sandbox, "existing-launch-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_admission_existing_1";
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd,
    clientAttemptId,
    requestDigest: "c".repeat(64),
    launchProfile: { title: "Existing launch" },
    origin: { kind: "operator" },
  });
  if (begun.kind !== "created") throw new Error("expected an existing-launch fixture");

  const response = await POST.withDependencies(request({
    title: "Existing launch",
    role: "deployer",
    roleParams: { sha: "c".repeat(40), pr: "26" },
    cwd,
    ["prompt"]: "refuse after an existing launch",
    clientAttemptId,
  }), { registry: () => store });

  expect(await response.json()).toMatchObject({ admissible: false, fenced: false, status: 400 });
  expect(readSpawnAdmissionFence(clientAttemptId)).toBeNull();
  expect(store.spawnReceiptForClientAttempt(clientAttemptId)?.launchId).toBe(begun.receipt.launchId);
});

/* #1641 — the mandatory reviewer contract. A reviewer spawn refused for a
   missing `reviews` used to answer a bare 400 on both paths, so the caller's
   downstream key carried no terminal evidence and recovery stayed unknown
   forever. The request reaches that refusal through two different branches
   depending on the request's origin, and both must fence. */

const REVIEWER_MISSING_REVIEWS = "reviewer requires reviews";

function reviewerBody(cwd: string, clientAttemptId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Independent runtime packet review",
    role: "reviewer",
    roleParams: { diffSource: "origin/main...HEAD" },
    engine: "codex",
    cwd,
    ["prompt"]: "review the runtime packet and return a verdict",
    clientAttemptId,
    ...extra,
  };
}

/** Headers of a launch dispatched by an agent through the MCP control path:
    no same-origin marker, and the operator spawn capability the Viewer's own
    control calls carry. */
function agentOriginHeaders(capability: string): Record<string, string> {
  return { "sec-fetch-site": "none", [VIEWER_SPAWN_CAPABILITY_HEADER]: capability };
}

test("a same-origin reviewer without reviews is fenced by the route and reported by the validator", async () => {
  const cwd = path.join(sandbox, "reviewer-same-origin-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const body = reviewerBody(cwd, "spawn_reviewer_same_origin_1");

  /* The route itself now records the request-bound fence on this branch. */
  const route = await spawnPost.withDependencies(spawnRequest(body), spawnDependencies(store, cwd));
  expect({ status: route.status, body: await route.json() }).toEqual({
    status: 400,
    body: { error: REVIEWER_MISSING_REVIEWS },
  });
  expect(readSpawnAdmissionFence(String(body.clientAttemptId))).toMatchObject({
    clientAttemptId: body.clientAttemptId,
    status: 400,
    error: REVIEWER_MISSING_REVIEWS,
  });
  expect(store.spawnReceiptForClientAttempt(String(body.clientAttemptId))).toBeNull();

  /* The validator reports the same refusal, in the admissibility shape the
     recovery probe reads, instead of calling the launch admissible. */
  const validation = await POST.withDependencies(request(body), { registry: () => store });
  expect(validation.status).toBe(200);
  expect(await validation.json()).toEqual({
    admissible: false,
    fenced: true,
    reason: REVIEWER_MISSING_REVIEWS,
    status: 400,
  });

  /* A changed payload cannot claim this refusal: the compare-and-set answers
     a conflict and reports fenced:false, so recovery of a request that is not
     the fenced one keeps its outcome unknown. */
  const changedPayload = await POST.withDependencies(
    request(reviewerBody(cwd, String(body.clientAttemptId), { ["prompt"]: "review something else entirely" })),
    { registry: () => store },
  );
  expect(await changedPayload.json()).toEqual({
    admissible: false,
    fenced: false,
    reason: REVIEWER_MISSING_REVIEWS,
    status: 400,
  });
  expect(readSpawnAdmissionFence(String(body.clientAttemptId))).toMatchObject({
    error: REVIEWER_MISSING_REVIEWS,
  });

  /* The burnt key cannot carry a different launch either: the reservation
     refuses it under the same lock, before any receipt or worker exists. */
  const reused = await spawnPost.withDependencies(
    spawnRequest({
      title: "A different launch on a burnt key",
      role: "verifier",
      roleParams: { claims: "the fenced key is terminal" },
      engine: "codex",
      cwd,
      ["prompt"]: "verify the supplied claim",
      clientAttemptId: body.clientAttemptId,
    }),
    spawnDependencies(store, cwd),
  );
  expect({ status: reused.status, body: await reused.json() }).toEqual({
    status: 409,
    body: { error: "spawn attempt conflicts with its original request" },
  });
  expect(store.spawnReceiptForClientAttempt(String(body.clientAttemptId))).toBeNull();
  expect(Object.keys(store.readOnlySnapshot().receipts)).toEqual([]);
});

test("an authenticated agent-origin reviewer without reviews is fenced at the lineage refusal", async () => {
  const cwd = path.join(sandbox, "reviewer-agent-origin-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const capability = ensureOperatorSpawnCapability();
  const routeKey = "spawn_reviewer_agent_route_1";
  const validateKey = "spawn_reviewer_agent_validate_1";

  /* An agent-origin request never reaches the role check: the lineage refusal
     fires first for the same missing field, and it fences too. */
  const route = await spawnPost.withDependencies(
    spawnRequest(reviewerBody(cwd, routeKey), agentOriginHeaders(capability)),
    spawnDependencies(store, cwd),
  );
  expect({ status: route.status, body: await route.json() }).toEqual({
    status: 400,
    body: { error: AGENT_SPAWN_LINEAGE_ERROR },
  });
  expect(readSpawnAdmissionFence(routeKey)).toMatchObject({ status: 400, error: AGENT_SPAWN_LINEAGE_ERROR });
  expect(store.spawnReceiptForClientAttempt(routeKey)).toBeNull();

  const validation = await POST.withDependencies(
    request(reviewerBody(cwd, validateKey), agentOriginHeaders(capability)),
    { registry: () => store },
  );
  expect(validation.status).toBe(200);
  expect(await validation.json()).toEqual({
    admissible: false,
    fenced: true,
    reason: AGENT_SPAWN_LINEAGE_ERROR,
    status: 400,
  });
  expect(readSpawnAdmissionFence(validateKey)).toMatchObject({ status: 400 });
  expect(Object.keys(store.readOnlySnapshot().receipts)).toEqual([]);
});

test("a reviewer naming its reviews target stays admissible and unfenced on both origins", async () => {
  const cwd = path.join(sandbox, "reviewer-admissible-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const capability = ensureOperatorSpawnCapability();
  const reviews = path.join(cwd, "implementer.jsonl");

  const sameOrigin = await POST.withDependencies(
    request(reviewerBody(cwd, "spawn_reviewer_named_same_1", { reviews })),
    { registry: () => store },
  );
  expect(await sameOrigin.json()).toEqual({ admissible: true, fenced: false });
  expect(readSpawnAdmissionFence("spawn_reviewer_named_same_1")).toBeNull();

  const agentOrigin = await POST.withDependencies(
    request(reviewerBody(cwd, "spawn_reviewer_named_agent_1", { reviews }), agentOriginHeaders(capability)),
    { registry: () => store },
  );
  expect(await agentOrigin.json()).toEqual({ admissible: true, fenced: false });
  expect(readSpawnAdmissionFence("spawn_reviewer_named_agent_1")).toBeNull();
});

test("reviews without the reviewer role is refused and fenced like any other admission error", async () => {
  const cwd = path.join(sandbox, "reviews-without-reviewer-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_reviews_without_reviewer_1";
  const body = {
    title: "Builder carrying a review target",
    role: "builder",
    cwd,
    ["prompt"]: "implement the scoped directive",
    reviews: path.join(cwd, "implementer.jsonl"),
    clientAttemptId,
  };

  const validation = await POST.withDependencies(request(body), { registry: () => store });
  expect(await validation.json()).toEqual({
    admissible: false,
    fenced: true,
    reason: "reviews requires role: reviewer",
    status: 400,
  });
  const route = await spawnPost.withDependencies(spawnRequest(body), spawnDependencies(store, cwd));
  expect({ status: route.status, body: await route.json() }).toEqual({
    status: 400,
    body: { error: "reviews requires role: reviewer" },
  });
  expect(Object.keys(store.readOnlySnapshot().receipts)).toEqual([]);
});

test("an unknown role keeps its baseline fenced refusal", async () => {
  const cwd = path.join(sandbox, "unknown-role-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_unknown_role_1";

  const validation = await POST.withDependencies(request({
    title: "Unknown role",
    role: "inspector",
    cwd,
    ["prompt"]: "run an inspection",
    clientAttemptId,
  }), { registry: () => store });
  const payload = await validation.json() as Record<string, unknown>;
  expect(payload).toMatchObject({ admissible: false, fenced: true, status: 400 });
  expect(String(payload.reason)).toStartWith("unknown role: inspector");
  expect(readSpawnAdmissionFence(clientAttemptId)).toMatchObject({ status: 400 });
});

test("an unauthenticated agent-origin reviewer cannot burn the owner's key", async () => {
  const cwd = path.join(sandbox, "reviewer-unauthenticated-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_reviewer_unauth_1";
  const body = reviewerBody(cwd, clientAttemptId);

  const validation = await POST.withDependencies(request(body, { "sec-fetch-site": "none" }), { registry: () => store });
  expect(validation.status).toBe(403);
  expect(readSpawnAdmissionFence(clientAttemptId)).toBeNull();

  const route = await spawnPost.withDependencies(
    spawnRequest(body, { "sec-fetch-site": "none" }),
    spawnDependencies(store, cwd),
  );
  expect({ status: route.status, body: await route.json() }).toEqual({
    status: 400,
    body: { error: AGENT_SPAWN_LINEAGE_ERROR },
  });
  expect(readSpawnAdmissionFence(clientAttemptId)).toBeNull();
  expect(Object.keys(store.readOnlySnapshot().receipts)).toEqual([]);
});

test("a launch receipt that already owns the key wins over a reviewer refusal", async () => {
  const cwd = path.join(sandbox, "reviewer-existing-launch-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const clientAttemptId = "spawn_reviewer_existing_1";
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd,
    clientAttemptId,
    requestDigest: "d".repeat(64),
    launchProfile: { title: "Reviewer already launched" },
    origin: { kind: "operator" },
  });
  if (begun.kind !== "created") throw new Error("expected an existing-launch fixture");

  const validation = await POST.withDependencies(
    request(reviewerBody(cwd, clientAttemptId)),
    { registry: () => store },
  );
  expect(await validation.json()).toEqual({
    admissible: false,
    fenced: false,
    reason: REVIEWER_MISSING_REVIEWS,
    status: 400,
  });
  expect(readSpawnAdmissionFence(clientAttemptId)).toBeNull();
  expect(store.spawnReceiptForClientAttempt(clientAttemptId)?.launchId).toBe(begun.receipt.launchId);
});

test("a malformed validation request is refused before anything is fenced", async () => {
  const store = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const malformed = new NextRequest("http://127.0.0.1:8898/api/spawn/validate", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:8898",
      host: "127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: "not json",
  });
  const response = await POST.withDependencies(malformed, { registry: () => store });
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 400,
    body: { error: "invalid JSON" },
  });

  const array = await POST.withDependencies(
    new NextRequest("http://127.0.0.1:8898/api/spawn/validate", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:8898",
        host: "127.0.0.1:8898",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ role: "reviewer", clientAttemptId: "spawn_malformed_array_1" }]),
    }),
    { registry: () => store },
  );
  expect(array.status).toBe(400);
  expect(readSpawnAdmissionFence("spawn_malformed_array_1")).toBeNull();
  expect(Object.keys(store.readOnlySnapshot().receipts)).toEqual([]);
});
