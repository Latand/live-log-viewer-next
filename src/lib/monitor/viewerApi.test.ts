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

  test("derives a pipeline's last movement from its stage attempts, not its birthday", async () => {
    const { impl } = stubFetch(() => ({ payload: { pipelines: [{
      id: "pipeline-1", task: "t", project: "viewer", state: "running", createdAt: "2026-07-20T09:00:00Z", closedAt: null,
      pausedAt: null, resumedAt: "2026-07-21T09:00:00Z",
      runs: [{ stageId: "build", attempts: [{ startedAt: "2026-07-20T09:05:00Z", completedAt: "2026-07-27T11:55:00Z" }] }],
    }] } }));
    const [pipeline] = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).pipelines();
    expect(pipeline!.activityAt).toContain("2026-07-27T11:55:00Z");
    expect(pipeline!.activityAt).toContain("2026-07-21T09:00:00Z");
    /* Creation time is not movement and must not sneak in as one. */
    expect(pipeline!.activityAt).not.toContain("2026-07-20T09:00:00Z");
  });

  test("derives a flow's last movement from its rounds", async () => {
    const { impl } = stubFetch(() => ({ payload: { flows: [{
      id: "flow-1", project: "viewer", state: "reviewing", createdAt: "2026-07-20T09:00:00Z", closedAt: null,
      rounds: [{ startedAt: "2026-07-20T10:00:00Z", reviewedAt: "2026-07-27T11:00:00Z", relayedAt: null, terminalAt: "nonsense" }],
    }] } }));
    const [flow] = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).flows();
    expect(flow!.activityAt).toEqual(["2026-07-20T10:00:00Z", "2026-07-27T11:00:00Z"]);
  });

  test("a payload with no movement evidence reports none rather than inventing it", async () => {
    const { impl } = stubFetch(() => ({ payload: { pipelines: [{ id: "p", task: "t", project: "viewer", state: "running", createdAt: "2026-07-20T09:00:00Z" }] } }));
    const [pipeline] = await httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl }).pipelines();
    expect(pipeline!.activityAt).toEqual([]);
  });

  test("reads and appends the audit journal through the viewer", async () => {
    const { calls, impl } = stubFetch((url) => url.includes("limit")
      ? { payload: { runs: [{ schemaVersion: 1, runId: "run-1", outcome: "clean" }] } }
      : { payload: { ok: true } });
    const api = httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl });
    const runs = await api.readRuns(3);
    expect(runs).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/monitor/runs?limit=3");

    await api.appendRun({ schemaVersion: 1, runId: "run-2" } as never);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toMatchObject({ record: { runId: "run-2" } });
  });

  test("claims and releases the single-flight lock through the viewer", async () => {
    let held = false;
    const { calls, impl } = stubFetch(() => ({ payload: held ? { claimed: false, detail: "another monitor run holds the lock" } : ((held = true), { claimed: true, token: "tok" }) }));
    const api = httpViewerApi({ baseUrl: "http://127.0.0.1:8898", fetchImpl: impl });
    const first = await api.claimRunLock();
    expect(first).toEqual({ claimed: true, token: "tok" });
    const second = await api.claimRunLock();
    expect(second.claimed).toBe(false);
    expect(calls[0]!.url).toContain("/api/monitor/lock");
    expect(calls[0]!.body).toMatchObject({ action: "claim" });
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
