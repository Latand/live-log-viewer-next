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

/** The operator's own Viewer: an ordinary same-origin fetch, presenting nothing. */
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
  /* Malformed body from the Viewer itself: the agent check passes, the parse does
     not. An AGENT gets 403 before the body is read at all, which is the point of
     checking authority first. */
  const invalid = new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: { host: "127.0.0.1" },
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

/* HIGH 4 (#758 review) — AXIS SEPARATION applies to the legacy flow too.
   Replacement is a DESIGNATION act: it rewrites the record, and with it every
   manager-level privilege (manager voice, confirmation minting) moves to the
   successor on the next tool call. It must never strip the predecessor's
   ordinary Viewer access or kill its host — split-brain is prevented by the
   record and the seat authority rejecting the predecessor, not by a kill. */

test("replacing a live incumbent NEVER touches the predecessor's conversation-action surface", async () => {
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

  /* The record moved — designation is complete… */
  expect(swapped.record).toMatchObject({ conversationId: "conv-2" });
  expect(swapped.replaced).toBe(true);
  /* …and the predecessor's host and session were left exactly as they were. */
  expect(retirements).toEqual([]);
  const status = await (await GET()).json();
  expect(status.record).toMatchObject({ conversationId: "conv-2" });
});

test("replacing the same conversation is a plain record update", async () => {
  await POST(adoptRequest({ conversationId: "conv-1", path: null }));
  const swapped = await (await POST(adoptRequest({
    conversationId: "conv-1", path: null, replace: true, model: "sonnet",
  }))).json();

  expect(retirements).toEqual([]);
  expect(swapped.record).toMatchObject({ conversationId: "conv-1", model: "sonnet" });
});

test("a replacement with no live predecessor behaves identically", async () => {
  const swapped = await (await POST(adoptRequest({ conversationId: "conv-1", path: null, replace: true }))).json();
  expect(swapped.record).toMatchObject({ conversationId: "conv-1" });
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

test("REGRESSION: one click adopts — a bare same-origin browser designates with nothing presented", async () => {
  /* The rejected build answered 403 here unless the operator had pasted a key into
     the tab, which is what left the manager unopenable after every reload. */
  const bare = new NextRequest("http://127.0.0.1/api/orchestrator", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conversation_one_click", path: null }),
  });
  const response = await POST(bare);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, adopted: true, record: { conversationId: "conversation_one_click" } });
  expect((await (await GET()).json()).record).toMatchObject({ conversationId: "conversation_one_click" });
});

test("an AGENT still cannot replace the manager, and the refusal changes nothing", async () => {
  /* The gate that matters and stays: designation is the one authority every other
     bridge gate keys off, so a worker able to appoint itself would inherit all of
     it in one move. */
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  await POST(browserRequest({ conversationId: "conv-incumbent", path: transcript }));

  setCallerConversationResolverForTests(() => "conversation_worker");
  const response = await POST(workerRequest({ conversationId: "conversation_impostor", path: null, replace: true }));
  expect(response.status).toBe(403);

  /* BOTH untouched. */
  expect((await (await GET()).json()).record).toMatchObject({ conversationId: "conv-incumbent" });
  expect(retirements).toEqual([]);
});

test("the operator's own Viewer may still designate", async () => {
  const response = await POST(browserRequest({ conversationId: "conv-1", path: null }));
  expect(response.status).toBe(200);
  expect((await (await GET()).json()).record).toMatchObject({ conversationId: "conv-1" });
});
