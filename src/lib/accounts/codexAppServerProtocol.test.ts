import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { parseAppServerMessage, redactAppServerDetail } from "./codexAppServerProtocol";

const fixtures = path.join(import.meta.dir, "fixtures");

function rows(name: string): unknown[] {
  return fs.readFileSync(path.join(fixtures, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function semantic(message: ReturnType<typeof parseAppServerMessage>): Record<string, unknown> {
  if (message.kind === "response") return message.error
    ? { kind: message.kind, id: message.id, error: message.error }
    : { kind: message.kind, id: message.id, result: message.result };
  if (message.kind === "request") return { kind: message.kind, id: message.id, method: message.method, params: message.params };
  return { kind: message.kind, method: message.method, params: message.params };
}

test("headerless and JSON-RPC 2.0 fixtures classify identically", () => {
  const headerless = rows("codex-app-server-v0.144.1-headerless.jsonl").map(parseAppServerMessage);
  const explicit = rows("codex-app-server-jsonrpc2.jsonl").map(parseAppServerMessage);
  expect(headerless.map(semantic)).toEqual(explicit.map(semantic));
  expect(headerless.map((message) => message.kind)).toEqual(["response", "notification", "request"]);
});

test("classifier rejects hybrid envelopes, bad versions, and malformed errors", () => {
  for (const value of [
    { jsonrpc: "1.0", id: 1, result: {} },
    { jsonrpc: null, method: "event" },
    { id: 1, method: "event", result: {} },
    { id: 1, result: {}, error: { code: 1, message: "x" } },
    { id: 1, error: { code: "-1", message: "x" } },
    { method: "" },
    { id: 1 },
  ]) expect(() => parseAppServerMessage(value)).toThrow("protocol error");
});

test("classifier preserves integer and string ids and redacts bounded detail", () => {
  expect(parseAppServerMessage({ id: 7, method: "ask" })).toMatchObject({ kind: "request", id: 7 });
  expect(parseAppServerMessage({ id: "request-7", method: "ask" })).toMatchObject({ kind: "request", id: "request-7" });
  const detail = redactAppServerDetail("authorization=very-secret access_token=another-secret");
  expect(detail).toContain("[REDACTED]");
  expect(detail).not.toContain("very-secret");
  expect(detail.length).toBeLessThanOrEqual(500);
});

test("seeded generated objects have one accepted message class at most", () => {
  let state = 0x40c0de;
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
  for (let index = 0; index < 500; index += 1) {
    const value: Record<string, unknown> = {};
    if (next() & 1) value.jsonrpc = next() & 1 ? "2.0" : "1.0";
    if (next() & 1) value.id = next() & 1 ? next() % 100 : `id-${next()}`;
    if (next() & 1) value.method = next() & 1 ? `method-${next()}` : "";
    if (next() & 1) value.result = {};
    if (next() & 1) value.error = { code: next() & 1 ? -1 : "-1", message: "error" };
    let accepted = 0;
    try { parseAppServerMessage(value); accepted += 1; } catch { /* rejected frames are expected */ }
    expect(accepted).toBeLessThanOrEqual(1);
  }
});
