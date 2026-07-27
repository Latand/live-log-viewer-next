import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-api-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { ViewerApiError, httpViewerApi } = await import("./viewerApi");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responder: (url: string) => { status?: number; payload?: unknown; body?: string }): { calls: Call[]; impl: typeof fetch } {
  const calls: Call[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const answer = responder(url);
    const body = answer.body ?? JSON.stringify(answer.payload ?? {});
    return new Response(body, { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("viewer api client", () => {
  test("resolves the orchestrator record and its liveness", async () => {
    const { impl } = stubFetch(() => ({ payload: { record: { conversationId: "conversation_abc", path: "/x/y.jsonl", createdAt: "2026-07-01T00:00:00Z" }, exists: true, defaultCwd: "/repo" } }));
    const status = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).orchestrator();
    expect(status.record?.conversationId).toBe("conversation_abc");
    expect(status.exists).toBe(true);
  });

  test("reads a null record without inventing one", async () => {
    const { impl } = stubFetch(() => ({ payload: { record: null, exists: false, defaultCwd: "/repo" } }));
    const status = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).orchestrator();
    expect(status.record).toBeNull();
    expect(status.exists).toBe(false);
  });

  test("scopes the conversation catalog by project", async () => {
    const { calls, impl } = stubFetch(() => ({ payload: { items: [{ path: "/x/a.jsonl", project: "viewer", title: "t", mtime: 1, kind: "session", engine: "claude" }, { project: "viewer" }] } }));
    const items = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).conversations({ project: "viewer", limit: 20 });
    expect(calls[0]!.url).toContain("project=viewer");
    expect(calls[0]!.url).toContain("limit=20");
    /* An entry with no path is unusable and is dropped rather than carried as
       an empty transcript reference. */
    expect(items).toHaveLength(1);
  });

  test("creates a board card as an unplaced item with its idempotency key", async () => {
    const { calls, impl } = stubFetch(() => ({ payload: { ok: true, task: { id: "task-1" } } }));
    const created = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).createCard({ project: "viewer", text: "body", clientRequestId: "monitor:abc" });
    expect(created.taskId).toBe("task-1");
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["sec-fetch-site"]).toBe("same-origin");
    expect(call.body).toMatchObject({ project: "viewer", placement: "unplaced", clientRequestId: "monitor:abc" });
  });

  test("delivers by conversation id, never by transcript path", async () => {
    const { calls, impl } = stubFetch(() => ({ payload: { ok: true, outcome: "delivered" } }));
    const result = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).deliver({ conversationId: "conversation_abc", text: "report", clientMessageId: "run-1" });
    expect(result.outcome).toBe("delivered");
    expect(calls[0]!.url).toContain("/api/tmux");
    expect(calls[0]!.body).toMatchObject({ conversationId: "conversation_abc", path: "" });
  });

  test("a refusing viewer surfaces as an error with its status", async () => {
    const { impl } = stubFetch(() => ({ status: 503, payload: { error: "scanner unavailable" } }));
    const api = httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl });
    expect(api.tasks()).rejects.toThrow(ViewerApiError);
  });

  test("an unreachable viewer surfaces as an error, not an empty result", async () => {
    const impl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const api = httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl });
    expect(api.pipelines()).rejects.toThrow(/failed/);
  });
});
