import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startComposerPayloadRuntime, type ComposerPayloadRuntime } from "./fixtures/composerPayloadRuntime";

/* A composer message with images and a file is admitted while its engine host
   is gone, and the delivery queue fences it as never executed. What recovers it
   once the host is back is the question: the sealed envelope resent under its
   original key, or the operation retry contract the receipt Retry uses. */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-payload-retry-"));
let runtime: ComposerPayloadRuntime;

function message(key: string, text: string, fill: number) {
  return {
    text,
    images: [0, 1, 2, 3].map((index) => ({
      base64: Buffer.concat([PNG, Buffer.alloc(256 * 1024, fill + index)]).toString("base64"),
      mime: "image/png",
    })),
    files: [{ name: "synthetic.bin", base64: Buffer.from(Array.from({ length: 256 }, (_, index) => (index + fill) % 256)).toString("base64") }],
    idempotencyKey: key,
    policy: "interrupt-active",
  };
}

async function call(method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await runtime.handle(new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const first = { key: "composer-payload-replay", text: "Resent under its original key", fill: 1 };
const second = { key: "composer-payload-recovery", text: "Recovered through the operation retry", fill: 9 };
const admitted = new Map<string, { operationId: string; revision: number }>();

beforeAll(async () => {
  runtime = await startComposerPayloadRuntime(directory);
  for (const item of [first, second]) {
    const response = await call("POST", "/api/runtime/send", { conversationId: runtime.conversationId, ...message(item.key, item.text, item.fill) });
    if (response.status !== 202) throw new Error(JSON.stringify(response));
    const operationId = response.json.operationId as string;
    await waitFor(() => runtime.journal.operationResult(operationId)?.receipt.status === "failed", `${item.key} to fail`);
    admitted.set(item.key, { operationId, revision: runtime.journal.operationResult(operationId)!.receipt.revision });
  }
  await runtime.hostUp();
});

afterAll(async () => {
  await runtime?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("an admitted send the queue fenced before actuation is a terminal journal failure", async () => {
  const { operationId } = admitted.get(second.key)!;
  expect(runtime.journal.operationResult(operationId)?.receipt).toMatchObject({
    idempotencyKey: second.key,
    status: "failed",
    reason: "structured host recovery did not start; retry the operation",
  });
  const query = await call("GET", `/api/runtime/operations/${operationId}`);
  expect(query.json.receipt).toMatchObject({ operationId, idempotencyKey: second.key, status: "failed" });
  expect(runtime.delivered).toEqual([]);
});

test("resending the sealed envelope under its original key replays the failure and delivers nothing", async () => {
  const { operationId, revision } = admitted.get(first.key)!;
  const operations = (await runtime.receipts()).length;
  const replay = await call("POST", "/api/runtime/send", { conversationId: runtime.conversationId, ...message(first.key, first.text, first.fill) });
  await Bun.sleep(200);
  expect(replay.status).toBe(409);
  expect(runtime.delivered).toEqual([]);
  expect(runtime.journal.operationResult(operationId)?.receipt).toMatchObject({ status: "failed", revision });
  expect((await runtime.receipts()).length).toBe(operations);
});

test("the operation retry contract delivers every original byte exactly once", async () => {
  const { operationId } = admitted.get(second.key)!;
  const expected = message(second.key, second.text, second.fill);
  const retry = await call("POST", `/api/runtime/operations/${operationId}`);
  expect(retry.status).toBe(202);
  const leafId = retry.json.operationId as string;
  const retryKey = `retry_${crypto.createHash("sha256").update(operationId).digest("hex")}`;
  expect(leafId).not.toBe(operationId);
  expect(retry.json.receipt).toMatchObject({ operationId, idempotencyKey: retryKey, retryOfOperationId: operationId });
  await waitFor(() => runtime.journal.operationResult(leafId)?.receipt.status === "delivered", "the retry leaf to deliver");

  expect(runtime.delivered).toHaveLength(1);
  const [delivered] = runtime.delivered;
  expect(delivered!.text.startsWith(`${second.text}\n`)).toBe(true);
  expect(delivered!.images.map((image) => image.base64)).toEqual(expected.images.map((image) => image.base64));
  expect(delivered!.files.map((file) => file.base64)).toEqual(expected.files.map((file) => file.base64));
  expect(runtime.journal.operationResult(leafId)?.receipt).toMatchObject({
    idempotencyKey: retryKey,
    retryOfOperationId: operationId,
    presentationOperationId: operationId,
    status: "delivered",
  });
  const leaf = await call("GET", `/api/runtime/operations/${leafId}`);
  expect(leaf.json.receipt).toMatchObject({ operationId: leafId, idempotencyKey: second.key, status: "delivered" });

  const repeated = await call("POST", `/api/runtime/operations/${operationId}`);
  expect(repeated.status).toBe(200);
  expect(repeated.json).toMatchObject({ operationId: leafId, receipt: { status: "delivered", retryOfOperationId: operationId } });
  await Bun.sleep(200);
  expect(runtime.delivered).toHaveLength(1);
});
