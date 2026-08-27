import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { NextRequest } from "next/server";

/* Issue #1224: the structured send route is the one the live composer uses, so
   a general attachment has to reach an agent through it too — bytes in the
   viewer inbox, path in the delivered text. The suite owns its config root:
   these tests write real attachments and must never touch the operator's live
   inbox (AGENTS.md), and the fixtures are invented bytes, never a real file. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-attachments-"));
const previous = {
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.LLV_STATE_DIR,
  staging: process.env.LLV_STAGING,
};
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, "config");
process.env.LLV_STATE_DIR = path.join(home, "state");
delete process.env.LLV_STAGING;
afterAll(() => {
  for (const [key, value] of [
    ["HOME", previous.home],
    ["XDG_CONFIG_HOME", previous.xdg],
    ["LLV_STATE_DIR", previous.state],
    ["LLV_STAGING", previous.staging],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const { handleRuntimeCommand } = await import("./http");
const { inboxFilesDir } = await import("@/lib/inboxFiles");
const { MAX_INBOX_FILE_BYTES } = await import("@/lib/filePolicy");
type Dependencies = Parameters<typeof handleRuntimeCommand>[2];

const attachment = (name: string, body: string) => ({ name, base64: Buffer.from(body, "utf8").toString("base64") });

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(enqueue: NonNullable<Dependencies>["enqueue"]): Dependencies {
  return {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => null,
    enqueue,
  };
}

const inboxEntries = () => (fs.existsSync(inboxFilesDir()) ? fs.readdirSync(inboxFilesDir()) : []);

test("a structured send carries its attachment as an inbox path in the delivered text", async () => {
  const admitted: Record<string, unknown>[] = [];
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "review the attached log",
    idempotencyKey: "send-with-file",
    files: [attachment("agent-trace.log", "invented log line")],
  }), "send", dependencies(async (input) => {
    admitted.push(input as unknown as Record<string, unknown>);
    return {
      ok: true,
      structured: true,
      target: "conversation_attach",
      outcome: "queued",
      operationId: "op_attach",
      receipt: { operationId: "op_attach", status: "queued" },
    } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>;
  }));

  expect(response.status).toBe(202);
  const text = String(admitted[0]!.text);
  const written = text.split("\n").at(-1)!;
  expect(text.startsWith("review the attached log\n")).toBe(true);
  expect(path.basename(written)).toBe("agent-trace.log");
  expect(fs.readFileSync(written, "utf8")).toBe("invented log line");
  /* No image capability was consulted: a file needs none. */
  expect(admitted[0]!.images).toBeUndefined();
  fs.rmSync(path.dirname(written), { recursive: true, force: true });
});

test("an attachment-only structured send is delivered rather than rejected as empty text", async () => {
  const admitted: Record<string, unknown>[] = [];
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "",
    idempotencyKey: "send-file-only",
    files: [attachment("notes.txt", "invented note")],
  }), "send", dependencies(async (input) => {
    admitted.push(input as unknown as Record<string, unknown>);
    return {
      ok: true,
      structured: true,
      target: "conversation_attach",
      outcome: "queued",
      operationId: "op_only",
      receipt: { operationId: "op_only", status: "queued" },
    } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>;
  }));

  expect(response.status).toBe(202);
  const written = String(admitted[0]!.text);
  expect(path.basename(written)).toBe("notes.txt");
  fs.rmSync(path.dirname(written), { recursive: true, force: true });
});

test("a refused structured send leaves no attachment bytes behind", async () => {
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "this will be refused",
    idempotencyKey: "send-refused",
    files: [attachment("orphan.bin", "invented bytes")],
  }), "send", dependencies(async () => ({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "structured host ownership is unavailable",
    status: 409,
  } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>)));

  expect(response.status).toBe(409);
  expect(inboxEntries()).toEqual([]);
});

test("round-3 finding 1: an uncertain delivery keeps the attachment it may already be carrying", async () => {
  const admitted: Record<string, unknown>[] = [];
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "the host connection dropped mid-command",
    idempotencyKey: "send-uncertain-transport",
    files: [attachment("incident.log", "invented incident line")],
  }), "send", dependencies(async (input) => {
    admitted.push(input as unknown as Record<string, unknown>);
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: "runtime host socket closed",
      status: 503,
      /* The transport failed; what the host did with the command is unknown. */
      transportUncertain: true,
    } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>;
  }));

  expect(response.status).toBe(503);
  /* The bytes are the ONLY copy — the browser uploaded them and let them go.
     A send that may still land was handed this exact path, so deleting on "not
     ok" hands the agent a path to a file the viewer just removed (#1224). */
  const written = String(admitted[0]!.text).split("\n").at(-1)!;
  expect(fs.existsSync(written)).toBe(true);
  expect(fs.readFileSync(written, "utf8")).toBe("invented incident line");
  fs.rmSync(path.dirname(written), { recursive: true, force: true });
});

test("round-3 finding 1: a host that answers `uncertain` keeps them too, and a rejection still releases them", async () => {
  const admitted: Record<string, unknown>[] = [];
  const uncertain = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "the host itself cannot say",
    idempotencyKey: "send-uncertain-receipt",
    files: [attachment("uncertain.txt", "invented bytes")],
  }), "send", dependencies(async (input) => {
    admitted.push(input as unknown as Record<string, unknown>);
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: "structured host delivery failed",
      status: 409,
      operationId: "op_uncertain",
      receipt: { operationId: "op_uncertain", status: "uncertain" },
    } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>;
  }));

  expect(uncertain.status).toBe(409);
  const written = String(admitted[0]!.text).split("\n").at(-1)!;
  expect(fs.existsSync(written)).toBe(true);
  fs.rmSync(path.dirname(written), { recursive: true, force: true });

  /* The other half of the same rule: a TERMINAL refusal is still swept, so
     retention did not simply become "keep everything". */
  const rejected = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "terminally refused",
    idempotencyKey: "send-rejected-receipt",
    files: [attachment("orphan.txt", "invented bytes")],
  }), "send", dependencies(async () => ({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "structured host delivery failed",
    status: 409,
    operationId: "op_rejected",
    receipt: { operationId: "op_rejected", status: "rejected" },
  } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>)));

  expect(rejected.status).toBe(409);
  expect(inboxEntries()).toEqual([]);
});

test("an oversized attachment is refused with its reason and never written", async () => {
  const enqueued: unknown[] = [];
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "too big",
    idempotencyKey: "send-oversize",
    files: [{ name: "huge.bin", base64: Buffer.alloc(MAX_INBOX_FILE_BYTES + 1, 9).toString("base64") }],
  }), "send", dependencies(async (input) => {
    enqueued.push(input);
    throw new Error("must not be reached");
  }));

  expect(response.status).toBe(413);
  const body = await response.json() as { error: string };
  expect(body.error).toContain("huge.bin");
  expect(body.error).toContain("too large");
  expect(enqueued).toEqual([]);
  expect(inboxEntries()).toEqual([]);
});

test("a send without attachments is byte-for-byte the send it always was", async () => {
  const admitted: Record<string, unknown>[] = [];
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "plain message",
    idempotencyKey: "send-plain",
  }), "send", dependencies(async (input) => {
    admitted.push(input as unknown as Record<string, unknown>);
    return {
      ok: true,
      structured: true,
      target: "conversation_attach",
      outcome: "queued",
      operationId: "op_plain",
      receipt: { operationId: "op_plain", status: "queued" },
    } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>;
  }));

  expect(response.status).toBe(202);
  expect(admitted[0]!.text).toBe("plain message");
  expect(inboxEntries()).toEqual([]);
});

test("an attachment larger than the command body ceiling still reaches the agent", async () => {
  const admitted: Record<string, unknown>[] = [];
  /* The bytes are on disk before the command is built, so the command's own
     256 KiB ceiling is about the COMMAND — a document twice that size is an
     ordinary attachment and must not be refused as an oversized request. */
  const body = "invented log line\n".repeat(24_000);
  expect(Buffer.from(body, "utf8").toString("base64").length).toBeGreaterThan(256 * 1024);
  const response = await handleRuntimeCommand(request({
    conversationId: "conversation_attach",
    text: "read the trace",
    idempotencyKey: "send-big-file",
    files: [attachment("big-trace.log", body)],
  }), "send", dependencies(async (input) => {
    admitted.push(input as unknown as Record<string, unknown>);
    return {
      ok: true,
      structured: true,
      target: "conversation_attach",
      outcome: "queued",
      operationId: "op_big",
      receipt: { operationId: "op_big", status: "queued" },
    } as Awaited<ReturnType<NonNullable<NonNullable<Dependencies>["enqueue"]>>>;
  }));

  expect(response.status).toBe(202);
  const written = String(admitted[0]!.text).split("\n").at(-1)!;
  expect(path.basename(written)).toBe("big-trace.log");
  expect(fs.readFileSync(written, "utf8")).toBe(body);
  fs.rmSync(path.dirname(written), { recursive: true, force: true });
});
