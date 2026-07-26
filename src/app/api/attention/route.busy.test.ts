import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

/*
 * Contention on `attention.json` is the server's problem, not the caller's.
 * `mutateAttention` runs under the shared file transaction, which throws
 * `FileTransactionBusyError` when the queued lock is exhausted; answering that
 * with 400 INVALID_REQUEST tells a well-formed client both that it was wrong
 * and that retrying is pointless. Both statements are false.
 *
 * The service is mocked rather than the lock genuinely starved: exhausting the
 * real queue takes 30 seconds of wall clock, and what is under test is the
 * route's mapping, not the lock.
 */

const service = await import("@/lib/attention/service");
const busy = () => { throw new FileTransactionBusyError("attention state is busy"); };

mock.module("@/lib/attention/service", () => ({
  ...service,
  attentionForDevice: busy,
  raiseAttentionRequest: busy,
  answerAttentionRequest: busy,
}));

const { GET, POST } = await import("./route");
const { POST: ANSWER } = await import("./[id]/route");

const headers = { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", "content-type": "application/json" };

async function expectBusy(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "ATTENTION_STATE_BUSY", message: "attention state is busy" });
  /* Retryable, and said so: the caller should come back rather than give up. */
  expect(response.headers.get("Retry-After")).toBe("1");
}

test("reading this device's offers while the record is locked is a retryable server condition", async () => {
  await expectBusy(await GET(new NextRequest("http://127.0.0.1:8898/api/attention?deviceId=device-a", { headers })));
});

test("raising a request while the record is locked is a retryable server condition", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/attention", {
    method: "POST",
    headers,
    body: JSON.stringify({
      origin: "root-agent",
      intent: "show",
      target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
      frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
      reason: "The reviewer finished with request-changes.",
    }),
  }));

  await expectBusy(response);
});

test("answering a request while the record is locked is a retryable server condition", async () => {
  const response = await ANSWER(
    new NextRequest("http://127.0.0.1:8898/api/attention/attention_1", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "decline", deviceId: "device-a" }),
    }),
    { params: Promise.resolve({ id: "attention_1" }) },
  );

  await expectBusy(response);
});
