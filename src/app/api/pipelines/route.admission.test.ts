import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-admission-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
fs.mkdirSync(path.join(process.env.LLV_CODEX_HOME, "sessions"), { recursive: true });

const { agentRegistry } = await import("@/lib/agent/registry");
const { POST } = await import("./route");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function seedCaller(role: string): { capability: string; conversationId: ViewerConversationId; path: string } {
  const store = agentRegistry();
  const capability = crypto.randomBytes(32).toString("base64url");
  const reviews = role === "reviewer"
    ? store.ensureConversation("codex", `/sessions/reviewed-${crypto.randomUUID()}.jsonl`, "terra").id
    : null;
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    role,
    reviewsConversationId: reviews,
    parentConversationId: reviews,
    origin: { kind: "operator" },
    spawnCapabilityDigest: crypto.createHash("sha256").update(capability).digest("hex"),
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(process.env.LLV_CODEX_HOME!, "sessions", `caller-${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return { capability, conversationId: settled.conversation.id, path: artifactPath };
}

function pipelineRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("an authenticated reviewer caller cannot create a pipeline", async () => {
  const caller = seedCaller("reviewer");
  const response = await POST(pipelineRequest(
    { task: "escape", repoDir: process.cwd(), src: caller.path },
    { "x-llv-spawn-capability": caller.capability },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "reviewer_origin_spawn",
    error: expect.stringContaining("in-session"),
  });
});

test("a declared reviewer src is rejected even without a capability header", async () => {
  const caller = seedCaller("verifier");
  const response = await POST(pipelineRequest({ task: "escape", repoDir: process.cwd(), src: caller.path }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "reviewer_origin_spawn" });
});

test("an authenticated builder caller without src derives durable creator lineage", async () => {
  const caller = seedCaller("builder");
  const authenticated = await POST(pipelineRequest(
    { task: "derived creator", repoDir: process.cwd(), autoStart: false, stages: [] },
    { "x-llv-spawn-capability": caller.capability },
  ));
  expect(authenticated.status).toBe(201);
  expect(await authenticated.json()).toMatchObject({
    pipeline: {
      srcPath: caller.path,
      srcConversationId: caller.conversationId,
    },
  });
});

test("an unattributed caller must pass src when creating a pipeline", async () => {
  const external = await POST(pipelineRequest({
    task: "missing creator",
    repoDir: process.cwd(),
    autoStart: false,
    stages: [],
  }));
  expect(external.status).toBe(400);
  expect(await external.json()).toEqual({ error: "pipeline creator lineage is required; pass src" });
});

test("a capability header that does not authenticate is rejected before pipeline creation", async () => {
  const response = await POST(pipelineRequest(
    { task: "escape", repoDir: process.cwd() },
    { "x-llv-spawn-capability": "B".repeat(43) },
  ));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: expect.stringContaining("x-llv-spawn-capability") });
});
