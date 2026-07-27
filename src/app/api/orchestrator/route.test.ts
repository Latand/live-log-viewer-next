import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import crypto from "node:crypto";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { setRetireManagerForTests } from "@/lib/orchestrator/retire";

import { GET, POST } from "./route";

let retirements: { conversationId: string; action: string }[] = [];
let retireOutcome: "ok" | "fail" = "ok";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orchestrator-route-"));
  process.env.LLV_STATE_DIR = sandbox;
  retirements = [];
  retireOutcome = "ok";
  /* The registry names this worker's capability, exactly as it would in production
     for any Viewer-spawned agent. */
  setCallerConversationResolverForTests((digest) =>
    digest === crypto.createHash("sha256").update(WORKER_CAPABILITY).digest("hex")
      ? "conversation_worker"
      : null);
  setRetireManagerForTests(async (conversationId) => {
    retirements.push({ conversationId, action: "kill" });
    if (retireOutcome === "fail") throw new Error("the predecessor could not be stopped");
    return "killed";
  });
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
  setRetireManagerForTests(null);
  setCallerConversationResolverForTests(null);
});

const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

/** The operator's own Viewer: a real browser's same-origin fetch. */
function browserRequest(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** A local worker, presenting the capability the registry issued it. */
function workerRequest(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: WORKER_CAPABILITY,
    },
    body: JSON.stringify(body),
  });
}

/* Existing cases predate the operator gate and are about adoption semantics, not
   authority; they speak as the Viewer. */
const adoptRequest = browserRequest;

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
  /* Malformed body from the Viewer itself: the operator gate passes, the parse does
     not. A bare local caller gets 403 before the body is read at all, which is the
     point of checking authority first. */
  const invalid = new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" },
    body: "{",
  });
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

/* #691 §3/§7.3, AC23 — a manager swap is a record update, and the production route
   has to be able to perform one. Adoption deliberately cannot: refusing a second
   conversation while one is live is the single-instance guarantee. */

test("POST replaces a live incumbent when the caller asks for a replacement", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  await POST(adoptRequest({ conversationId: "conv-1", path: transcript }));

  /* Without an explicit replacement this is refused, and must stay refused. */
  const refused = await (await POST(adoptRequest({ conversationId: "conv-2", path: null }))).json();
  expect(refused).toMatchObject({ adopted: false, record: { conversationId: "conv-1" } });

  const swapped = await (await POST(adoptRequest({
    conversationId: "conv-2",
    path: null,
    replace: true,
    engine: "codex",
    model: "sol",
  }))).json();
  expect(swapped).toMatchObject({
    ok: true,
    adopted: true,
    replaced: true,
    record: { conversationId: "conv-2", engine: "codex", model: "sol" },
  });

  const status = await (await GET()).json();
  expect(status.record).toMatchObject({ conversationId: "conv-2", engine: "codex", model: "sol" });
});

test("a replacement defaults to the standing incumbent identity when none is named", async () => {
  await POST(adoptRequest({ conversationId: "conv-1", path: null }));
  const swapped = await (await POST(adoptRequest({ conversationId: "conv-2", path: null, replace: true }))).json();
  expect(swapped.record).toMatchObject({ conversationId: "conv-2", engine: "claude", model: "opus" });
});

test("the adopted record carries the incumbent engine and model", async () => {
  const adopted = await (await POST(adoptRequest({ conversationId: "conv-1", path: null }))).json();
  expect(adopted.record).toMatchObject({ engine: "claude", model: "opus" });
});

test("POST refuses a non-string engine or model rather than storing it", async () => {
  for (const body of [
    { conversationId: "conv-1", path: null, engine: 7 },
    { conversationId: "conv-1", path: null, model: {} },
  ]) {
    expect((await POST(adoptRequest(body))).status).toBe(400);
  }
});

/* Round 2 — a swap must leave exactly ONE live manager. Rewriting the record while
   the predecessor is still running is split-brain: two agents both believe they own
   the board, and the bridge references whichever the record happens to name. */

test("replacing a live incumbent retires the predecessor", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  await POST(adoptRequest({ conversationId: "conv-1", path: transcript }));

  const swapped = await (await POST(adoptRequest({
    conversationId: "conv-2",
    path: null,
    replace: true,
    engine: "codex",
    model: "sol",
  }))).json();

  expect(swapped.retired).toEqual({ conversationId: "conv-1", outcome: "killed" });
  expect(retirements).toEqual([{ conversationId: "conv-1", action: "kill" }]);
});

test("a replacement that cannot retire the predecessor does not seat the successor", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  await POST(adoptRequest({ conversationId: "conv-1", path: transcript }));
  retireOutcome = "fail";

  const response = await POST(adoptRequest({ conversationId: "conv-2", path: null, replace: true }));
  expect(response.status).toBe(409);

  /* Split-brain avoided by refusing the swap: the record still names the only
     manager that is actually running. */
  const status = await (await GET()).json();
  expect(status.record).toMatchObject({ conversationId: "conv-1" });
});

test("replacing the same conversation is a no-op rather than a self-kill", async () => {
  await POST(adoptRequest({ conversationId: "conv-1", path: null }));
  const swapped = await (await POST(adoptRequest({
    conversationId: "conv-1", path: null, replace: true, model: "sonnet",
  }))).json();

  expect(retirements).toEqual([]);
  expect(swapped.record).toMatchObject({ conversationId: "conv-1", model: "sonnet" });
});

test("a replacement with no live predecessor retires nothing", async () => {
  const swapped = await (await POST(adoptRequest({ conversationId: "conv-1", path: null, replace: true }))).json();
  expect(swapped.retired).toBeNull();
  expect(retirements).toEqual([]);
});

/* Round 5 — designation change is operator-only.
   Every bridge gate keys off "is this the designated manager", so anything able to
   APPOINT the manager inherits all of that authority at once: manager-only
   bridge_report, and (before this round) speech injection. A local worker holds a
   spawn capability the registry can name, which is exactly what is refused here. */

test("a worker cannot appoint itself the manager, and the refusal changes nothing", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  await POST(adoptRequest({ conversationId: "conv-incumbent", path: transcript }));

  const response = await POST(workerRequest({
    conversationId: "conversation_worker",
    path: null,
    replace: true,
  }));

  expect(response.status).toBe(403);
  /* BOTH untouched: the record still names the incumbent, and nothing tried to
     retire it — a refusal that killed the live manager first would be its own
     denial of service. */
  const status = await (await GET()).json();
  expect(status.record).toMatchObject({ conversationId: "conv-incumbent" });
  expect(retirements).toEqual([]);
});

test("a worker cannot adopt the slot when no manager is designated either", async () => {
  /* Adoption confers the same authority when the seat is empty, so it is gated the
     same way. */
  const response = await POST(workerRequest({ conversationId: "conversation_worker", path: null }));

  expect(response.status).toBe(403);
  expect((await (await GET()).json()).record).toBeNull();
});

test("a caller that presents no credential and does not look like the Viewer is refused", async () => {
  const bare = new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conv-1", path: null }),
  });
  expect((await POST(bare)).status).toBe(403);
  expect((await (await GET()).json()).record).toBeNull();
});

test("the operator's own Viewer may still designate", async () => {
  const response = await POST(browserRequest({ conversationId: "conv-1", path: null }));
  expect(response.status).toBe(200);
  expect((await (await GET()).json()).record).toMatchObject({ conversationId: "conv-1" });
});
