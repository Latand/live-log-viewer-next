import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { recordManagerReport } from "@/lib/bridge/service";
import { readBridgeChannel } from "@/lib/bridge/store";
import { recordRootSession } from "@/lib/root/store";

import { GET, POST } from "./route";

/**
 * The route the reviewer found missing: the production drain.
 *
 * These go through the real handlers against the real state files, because the
 * complaint was never that the primitives were wrong — it was that nothing ran
 * them in order. A test with a stubbed service would pass on a route that drains
 * nothing.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-route-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  /* A real root lineage, so the route resolves the same durable identity
     production does rather than an injected one. */
  recordRootSession({ conversationId: "conversation_root", path: null });
}

const ORIGIN = "http://127.0.0.1";

function get(query = ""): Promise<Response> {
  return GET(new NextRequest(`${ORIGIN}/api/bridge${query}`, {
    headers: { host: "127.0.0.1" },
  })) as unknown as Promise<Response>;
}

function post(body: unknown): Promise<Response> {
  return POST(new NextRequest(`${ORIGIN}/api/bridge`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as unknown as Promise<Response>;
}

test("an empty bridge drains nothing and creates the channel for the live root", async () => {
  sandbox();
  const payload = await (await get()).json() as { ok: boolean; plan: { kind: string } };
  expect(payload.ok).toBe(true);
  expect(payload.plan.kind).toBe("idle");
  expect(readBridgeChannel()?.rootId).toMatch(/^root_/);
});

test("a manager report is drained through the route and only acknowledged when the caller says so", async () => {
  sandbox();
  recordManagerReport({
    key: "stage-9",
    class: "completed",
    at: new Date().toISOString(),
    body: "reviewer approved #726",
  });

  const drained = await (await get()).json() as {
    plan: { kind: string; throughSeq: number; delivery: { responses: { text: string }[] } };
  };
  expect(drained.plan.kind).toBe("deliver");
  expect(drained.plan.throughSeq).toBe(1);
  expect(drained.plan.delivery.responses[0]!.text).toContain("reviewer approved #726");

  /* GET must not have moved the cursor: a batch lost between here and the call has
     to arrive again. */
  expect(readBridgeChannel()?.managerReportCursor).toBe(0);

  expect((await post({ throughSeq: 1 })).status).toBe(200);
  expect(readBridgeChannel()?.managerReportCursor).toBe(1);

  const after = await (await get()).json() as { plan: { kind: string } };
  expect(after.plan.kind).toBe("idle");
});

test("the coalescing window is honoured through the route", async () => {
  sandbox();
  recordManagerReport({ key: "a", class: "status", at: new Date().toISOString(), body: "one" });
  const justNow = new Date(Date.now() - 1_000).toISOString();
  const held = await (await get(`?lastBatchAt=${encodeURIComponent(justNow)}`)).json() as { plan: { kind: string } };
  expect(held.plan.kind).toBe("hold");
});

test("a client that already played a batch gets the healing seq, not silence", async () => {
  sandbox();
  recordManagerReport({ key: "a", class: "status", at: new Date().toISOString(), body: "one" });
  const first = await (await get()).json() as { plan: { delivery: { deliveryId: string } } };
  const acked = encodeURIComponent(first.plan.delivery.deliveryId);

  const healing = await (await get(`?acked=${acked}`)).json() as { plan: { kind: string; throughSeq: number } };
  expect(healing.plan).toEqual({ kind: "already-acknowledged", throughSeq: 1 });

  await post({ throughSeq: healing.plan.throughSeq });
  expect(readBridgeChannel()?.managerReportCursor).toBe(1);
});

test("acknowledging refuses anything that is not a positive seq", async () => {
  sandbox();
  for (const body of [{}, { throughSeq: 0 }, { throughSeq: "2" }, { throughSeq: 1.5 }]) {
    expect((await post(body)).status).toBe(400);
  }
});

test("the acknowledgement route refuses a cross-origin caller", async () => {
  sandbox();
  const response = await POST(new NextRequest(`${ORIGIN}/api/bridge`, {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ throughSeq: 1 }),
  })) as unknown as Response;
  expect(response.status).toBe(403);
});

test("the drain never carries a work log, a tool call or a journal entry (AC12)", async () => {
  sandbox();
  recordManagerReport({
    key: "only-prose",
    class: "blocked",
    at: new Date().toISOString(),
    body: "merge #726 despite the flaky test, or hold?",
  });
  const body = await (await get()).text();
  for (const word of ["toolCall", "tool_use", "lifecycle", "journal", "transcript"]) {
    expect(body).not.toContain(word);
  }
});
