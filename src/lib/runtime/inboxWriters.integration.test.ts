import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { startComposerPayloadRuntime, type ComposerPayloadRuntime } from "./fixtures/composerPayloadRuntime";

/* #1652: the inbox batch derives from the key alone, while the journal scopes a
   key by conversation, so a queued message's accepted file sits on paths an
   ordinary send of any conversation reaches with the same key. The real
   handlers over the real journal: whatever those other writers do, the
   accepted file keeps its bytes and the original queue request still replays.
   The keys and bytes are invented. */

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-inbox-writers-"));
let runtime: ComposerPayloadRuntime;
let inboxFilesDir: () => string;
let inboxFileBatchToken: (key: string) => string;
let conversationHostPOST: (request: NextRequest) => Promise<Response>;
let setConversationHostDependenciesForTests: typeof import("@/app/api/conversation-host/dependencies").setConversationHostDependenciesForTests;

const accepted = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x7f, 0x80, 0x0d, 0x0a]);
const replacement = Buffer.from("replacement bytes");
const attachment = (data: Buffer) => [{ name: "trace.bin", base64: data.toString("base64") }];

beforeAll(async () => {
  runtime = await startComposerPayloadRuntime(directory);
  ({ inboxFilesDir, inboxFileBatchToken } = await import("@/lib/inboxFiles"));
  ({ conversationHostPOST } = await import("@/app/api/conversation-host/handlers"));
  ({ setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies"));
});

afterAll(async () => {
  setConversationHostDependenciesForTests(null);
  await runtime.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function post(route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await runtime.handle(new Request(`http://localhost${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

/** A queued message under `key`, admitted, with its accepted file's path. */
async function queued(key: string) {
  const body = {
    conversationId: runtime.queue.conversationId, idempotencyKey: key, action: "add", text: "read the trace",
    binding: { threadId: runtime.queue.threadId, accountId: runtime.queue.accountId }, files: attachment(accepted),
  };
  const first = await post("/api/runtime/queue", body);
  expect(first.status).toBe(202);
  const file = path.join(inboxFilesDir(), inboxFileBatchToken(key), "trace.bin");
  return { body, file, inode: fs.statSync(file).ino, operationId: first.json.operationId };
}

/** The accepted file is whole, the original request replays as the same
    operation, and the queue holds that one message. */
async function expectQueuedIntact(entry: Awaited<ReturnType<typeof queued>>, key: string) {
  expect(fs.readFileSync(entry.file).equals(accepted)).toBeTrue();
  expect(fs.statSync(entry.file).ino).toBe(entry.inode);
  const replay = await post("/api/runtime/queue", entry.body);
  expect(replay.status).toBe(202);
  expect(replay.json.operationId).toBe(entry.operationId);
  expect(replay.json.replayed).toBeTrue();
  const token = inboxFileBatchToken(key);
  expect(runtime.journal.nativeQueueRead(runtime.queue.conversationId)
    .filter((item) => item.versions[0]!.text.includes(token))).toHaveLength(1);
}

test("an ordinary send of another conversation under the key cannot replace the queued file", async () => {
  const entry = await queued("shared-changed-bytes");
  const send = await post("/api/runtime/send", {
    conversationId: runtime.conversationId, idempotencyKey: "shared-changed-bytes", text: "conflicting route",
    files: attachment(replacement),
  });
  await expectQueuedIntact(entry, "shared-changed-bytes");
  expect(send.status).toBe(409);
  expect(String(send.json.error)).toContain("different contents");
});

test("a refused ordinary send under the key leaves the queued file it found", async () => {
  const entry = await queued("shared-refused");
  /* The queue's own conversation has no ordinary-send owner, so the real
     admission refuses the send terminally. */
  const send = await post("/api/runtime/send", {
    conversationId: runtime.queue.conversationId, idempotencyKey: "shared-refused", text: "refused route",
    files: attachment(accepted),
  });
  await expectQueuedIntact(entry, "shared-refused");
  expect(send.status).toBe(503);
  expect(String(send.json.error)).toContain("synchronizing");
});

test("an accepted ordinary send with the same bytes shares the file without rewriting it", async () => {
  const entry = await queued("shared-accepted");
  const send = await post("/api/runtime/send", {
    conversationId: runtime.conversationId, idempotencyKey: "shared-accepted", text: "same bytes",
    files: attachment(accepted),
  });
  expect(send.status).toBe(202);
  await expectQueuedIntact(entry, "shared-accepted");
});

test("an invalid ordinary send is refused before it writes anything", async () => {
  const entry = await queued("shared-invalid");
  const send = await post("/api/runtime/send", {
    conversationId: runtime.conversationId, idempotencyKey: "shared-invalid", text: "invalid route", policy: "invented",
    files: attachment(replacement),
  });
  await expectQueuedIntact(entry, "shared-invalid");
  expect(fs.readdirSync(path.dirname(entry.file))).toEqual(["trace.bin"]);
  expect(send.status).toBe(400);
  expect(send.json.error).toBe("policy is invalid");
});

test("control: an ordinary send under its own key writes its own batch", async () => {
  const entry = await queued("own-key");
  const send = await post("/api/runtime/send", {
    conversationId: runtime.conversationId, idempotencyKey: "own-key-send", text: "own key", files: attachment(replacement),
  });
  expect(send.status).toBe(202);
  expect(fs.readFileSync(path.join(inboxFilesDir(), inboxFileBatchToken("own-key-send"), "trace.bin")).equals(replacement)).toBeTrue();
  await expectQueuedIntact(entry, "own-key");
});

test("the legacy conversation-host send under the key can neither replace nor delete the queued file", async () => {
  setConversationHostDependenciesForTests({
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
    recordDirectOperatorWakatimeActivity: () => null,
    collectImagePayloads: () => ({ images: [], error: null }),
    /* A terminal refusal, so the route releases what it wrote. */
    enqueueStructuredMessage: async () => ({
      ok: false, structured: true, outcome: "failed", error: "structured host ownership is unavailable", status: 409,
    }) as never,
  });
  try {
    const entry = await queued("shared-legacy");
    const hostSend = (data: Buffer) => conversationHostPOST(new NextRequest("http://127.0.0.1/api/tmux", {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ conversationId: runtime.conversationId, clientMessageId: "shared-legacy", text: "legacy route", files: attachment(data) }),
    }));
    const changed = await hostSend(replacement);
    expect(fs.readFileSync(entry.file).equals(accepted)).toBeTrue();
    const refused = await hostSend(accepted);
    await expectQueuedIntact(entry, "shared-legacy");
    /* The legacy route answers any save failure with 500. */
    expect(changed.status).toBe(500);
    expect(String((await changed.json() as { error?: string }).error)).toContain("different contents");
    expect(refused.status).toBe(409);
  } finally {
    setConversationHostDependenciesForTests(null);
  }
});
