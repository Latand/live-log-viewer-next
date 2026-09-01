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
import { GET as seatGet, POST as seatPost } from "./route";

/*
 * BLOCKING 1 (#758 review), the route half: the DESIGNATION surface refuses a
 * caller that names itself as an agent conversation via the forwarded launch
 * capability, before the body is read and before anything durable changes.
 * The binding half — that the MCP tools actually forward that capability — is
 * proven in `src/lib/mcp/orchestratorTools.test.ts`.
 *
 * ROTATION is the deliberate exception (#1402), and the route itself is what
 * proves it here: the identical request that the seat route refuses as an agent
 * reaches the rotation command, which answers on its own terms.
 * The accepted end-to-end rotation, with the caller attributed, lives in
 * `src/lib/orchestrator/rotationAuthority.test.ts` — this file must not run a
 * real spawn.
 */

let sandbox = "";
let previousStateDir: string | undefined;
let previousHome: string | undefined;
const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  previousHome = process.env.HOME;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-route-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.HOME = sandbox;
  setCallerConversationResolverForTests((digest) =>
    digest === crypto.createHash("sha256").update(WORKER_CAPABILITY).digest("hex")
      ? "conversation_worker"
      : null);
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
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

test("a capability-presenting agent is refused DESIGNATION at the seat route, and no seat state changes", async () => {
  const seat = await seatPost(agentRequest("/api/orchestrator/seat", {
    project: "proj-a",
    mandate: "mine now",
    clientRequestId: "req_00000001",
  }));
  expect(seat.status).toBe(403);
  expect(await seat.json()).toMatchObject({ error: expect.stringContaining("an agent may not perform it") });

  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending).toBeNull();
});

test("REGRESSION (#1402): the same agent request is ADMITTED by the rotation route, which answers about the seat whoever asked", async () => {
  const rotate = await rotatePost(agentRequest("/api/orchestrator/rotate", {
    project: "proj-a",
    clientRequestId: "req_00000002",
  }));

  /* Not 403 and not the operator-only sentence: nothing is designated for this
     project, so the rotation command's own refusal is what comes back. */
  expect(rotate.status).toBe(409);
  expect(await rotate.json()).toMatchObject({ code: "no_incumbent" });

  const { active, pending } = orchestratorSeatFor("proj-a");
  expect(active).toBeNull();
  expect(pending).toBeNull();
});

test("the seat read reports the Viewer MCP definition resolved for the project cwd", async () => {
  const project = path.join(sandbox, "project");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });

  const missing = await seatGet(new NextRequest(`http://127.0.0.1/api/orchestrator/seat?project=proj-a&cwd=${encodeURIComponent(project)}`));
  expect(await missing.json()).toMatchObject({ viewerMcpRegistered: false });

  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({
    mcpServers: { viewer: { type: "stdio", command: "project-viewer" } },
  }));
  const registered = await seatGet(new NextRequest(`http://127.0.0.1/api/orchestrator/seat?project=proj-a&cwd=${encodeURIComponent(project)}`));
  expect(await registered.json()).toMatchObject({ viewerMcpRegistered: true });
});
