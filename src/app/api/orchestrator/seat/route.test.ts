import crypto from "node:crypto";

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";

import { POST as rotatePost } from "../rotate/route";
import { POST as seatPost } from "./route";

/*
 * BLOCKING 1 (#758 review), the route half: the designation surface refuses a
 * caller that names itself as an agent conversation via the forwarded launch
 * capability, before the body is read and before anything durable changes.
 * The binding half — that the MCP tools actually forward that capability — is
 * proven in `src/lib/mcp/orchestratorTools.test.ts`.
 */

let sandbox = "";
let previousStateDir: string | undefined;
const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-route-"));
  process.env.LLV_STATE_DIR = sandbox;
  setCallerConversationResolverForTests((digest) =>
    digest === crypto.createHash("sha256").update(WORKER_CAPABILITY).digest("hex")
      ? "conversation_worker"
      : null);
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function agentRequest(pathname: string, body: unknown): NextRequest {
  return new NextRequest(`http://127.0.0.1${pathname}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: WORKER_CAPABILITY,
    },
    body: JSON.stringify(body),
  });
}

test("a capability-presenting agent is refused designation at both routes, and no seat state changes", async () => {
  const seat = await seatPost(agentRequest("/api/orchestrator/seat", {
    project: "proj-a",
    mandate: "mine now",
    clientRequestId: "req_00000001",
  }));
  expect(seat.status).toBe(403);

  const rotate = await rotatePost(agentRequest("/api/orchestrator/rotate", {
    project: "proj-a",
    clientRequestId: "req_00000002",
  }));
  expect(rotate.status).toBe(403);

  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending).toBeNull();
});
