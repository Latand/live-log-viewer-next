import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";

import { SqliteMcpReceiptStore } from "@/lib/mcp/server";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";

import { GET } from "./route";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-operations-route-"));
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const receipts = () => path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite");

function request(query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1/api/mcp/operations${query}`);
}

type Row = { sequence: number; tool: string; state: string; target: unknown };
type Page = { operations: Row[]; refreshed: Row[]; after: number; hasMore: boolean; creationsAfter: string; creationsHasMore: boolean };

test("the route refuses a missing project or a malformed cursor, unresolved list or creations cursor, and answers an absent database with an empty page", async () => {
  expect((await GET(request(""))).status).toBe(400);
  expect((await GET(request("?project=alpha&after=abc"))).status).toBe(400);
  expect((await GET(request("?project=alpha&after=-1"))).status).toBe(400);
  expect((await GET(request("?project=alpha&unresolved=1,x"))).status).toBe(400);
  const tooMany = Array.from({ length: 51 }, (_value, index) => index + 1).join(",");
  expect((await GET(request(`?project=alpha&unresolved=${tooMany}`))).status).toBe(400);
  expect((await GET(request("?project=alpha&creationsAfter=soon"))).status).toBe(400);

  const empty = await GET(request("?project=alpha&after=3&unresolved=1,2"));
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({ operations: [], after: 3, hasMore: false, refreshed: [], creationsAfter: "0:", creationsHasMore: false });
  expect(fs.existsSync(receipts())).toBeFalse();
});

test("the route reads receipt rows without writing them, joins a stamped pipeline by its digest, answers unresolved sequences and discovers stamps after its cursor", async () => {
  new SqliteMcpReceiptStore(receipts()).close();
  const writer = new Database(receipts(), { strict: true });
  const insert = writer.query("INSERT INTO mcp_receipts(receipt_key, digest, retention, result_json, storage_bytes, claimed_at, caller_json, target_json) VALUES (?, ?, 'durable', ?, 1, ?, ?, ?)");
  insert.run("create_pipeline:lost-response", "digest-stamped", JSON.stringify({ ok: false, error: "deadline" }), Date.now(), null, null);
  insert.run(
    "update_task:moving", "digest-moving", null, Date.now(),
    JSON.stringify({ kind: "worker", conversationId: "conversation_manager", project: "alpha" }),
    JSON.stringify({ project: "alpha", taskId: "task-1", pipelineId: null }),
  );
  writer.close();
  const recordedAt = new Date().toISOString();
  savePipelines([buildPipeline({
    id: "pipe0001",
    task: "Ship",
    project: "alpha",
    repoDir: path.join(process.env.LLV_STATE_DIR!, "repo"),
    stages: [],
    srcPath: null,
    srcConversationId: null,
    now: recordedAt,
    state: "draft",
    creationReceipt: { tool: "create_pipeline", requestDigest: "digest-stamped", callerConversationId: null, claimedAt: recordedAt, recordedAt },
  })]);
  const before = fs.readFileSync(receipts());

  const first = await GET(request("?project=alpha&limit=999"));
  expect(first.status).toBe(200);
  const page = await first.json() as Page;
  expect(page.operations.map(({ tool, state, target }) => ({ tool, state, target }))).toEqual([
    { tool: "create_pipeline", state: "accepted", target: { project: "alpha", taskId: null, pipelineId: "pipe0001" } },
    { tool: "update_task", state: "pending", target: { project: "alpha", taskId: "task-1", pipelineId: null } },
  ]);
  expect(page).toMatchObject({ after: 2, hasMore: false, creationsAfter: `${Date.parse(recordedAt)}:digest-stamped`, creationsHasMore: false });

  const unrelated = await (await GET(request("?project=beta&after=0&unresolved=1,2&creationsAfter=0:"))).json() as Page;
  expect(unrelated).toEqual({ operations: [], after: 2, hasMore: false, refreshed: [], creationsAfter: "0:", creationsHasMore: false });

  const followUp = await (await GET(request(`?project=alpha&after=${page.after}&unresolved=2&creationsAfter=${page.creationsAfter}`))).json() as Page;
  expect(followUp.operations).toEqual([]);
  expect(followUp.refreshed.map(({ sequence, state }) => [sequence, state])).toEqual([[2, "pending"]]);

  const fromStart = await (await GET(request(`?project=alpha&after=${page.after}&creationsAfter=0:`))).json() as Page;
  expect(fromStart.refreshed.map(({ sequence, state }) => [sequence, state])).toEqual([[1, "accepted"]]);
  expect(fromStart.creationsAfter).toBe(page.creationsAfter);
  expect(fs.readFileSync(receipts()).equals(before)).toBeTrue();
});
