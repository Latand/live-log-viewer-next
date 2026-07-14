import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { GET, POST } from "./route";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orchestrator-route-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function adoptRequest(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET reports the empty slot with the viewer checkout as spawn cwd", async () => {
  const body = await (await GET()).json();
  expect(body).toEqual({ record: null, exists: false, defaultCwd: process.cwd() });
});

test("POST adopts the first conversation and echoes the winner to losers", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  const first = await (await POST(adoptRequest({ conversationId: "conv-1", path: transcript }))).json();
  expect(first).toMatchObject({ ok: true, adopted: true, record: { conversationId: "conv-1", path: transcript } });

  const loser = await (await POST(adoptRequest({ conversationId: "conv-2", path: null }))).json();
  expect(loser).toMatchObject({ ok: true, adopted: false, record: { conversationId: "conv-1" } });

  const status = await (await GET()).json();
  expect(status).toMatchObject({ record: { conversationId: "conv-1", path: transcript }, exists: true });
});

test("GET flags a deleted transcript so the button respawns", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  await POST(adoptRequest({ conversationId: "conv-1", path: transcript }));
  fs.rmSync(transcript);
  const status = await (await GET()).json();
  expect(status).toMatchObject({ record: { conversationId: "conv-1" }, exists: false });
});

test("POST validates its body", async () => {
  expect((await POST(adoptRequest({}))).status).toBe(400);
  expect((await POST(adoptRequest({ conversationId: "  " }))).status).toBe(400);
  expect((await POST(adoptRequest({ conversationId: "conv-1", path: 7 }))).status).toBe(400);
  const invalid = new NextRequest("http://127.0.0.1/api/orchestrator", { method: "POST", headers: { host: "127.0.0.1" }, body: "{" });
  expect((await POST(invalid)).status).toBe(400);
});

test("POST rejects cross-origin browsers", async () => {
  const request = new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conv-1" }),
  });
  expect((await POST(request)).status).toBe(403);
});
