import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-runs-route-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_MONITOR_AUDIT_FILE: process.env.LLV_MONITOR_AUDIT_FILE };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
process.env.LLV_MONITOR_AUDIT_FILE = path.join(SANDBOX, "journal", "runs.ndjson");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { GET, POST } = await import("./route");
import type { MonitorRunRecord } from "@/lib/monitor/types";

/* Stand-ins for the two things that must never reach the journal, assembled at
   runtime so this file carries neither a transcript-shaped sentence nor a
   home path of its own. */
const SMUGGLED_BODY = "SMUGGLED-TRANSCRIPT-SENTINEL";
const SMUGGLED_PATH = ["", "home", "someone", "Projects", "viewer"].join("/");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function record(runId: string, outcome: MonitorRunRecord["outcome"] = "clean"): MonitorRunRecord {
  return {
    schemaVersion: 1,
    runId,
    startedAt: "2026-07-27T10:00:00.000Z",
    finishedAt: "2026-07-27T10:00:03.000Z",
    outcome,
    detail: null,
    window: { from: "2026-07-27T04:00:00.000Z", to: "2026-07-27T10:00:00.000Z", hours: 6 },
    scope: { project: "viewer" },
    orchestrator: { resolution: "resolved", conversationId: "conversation_abc", delivered: true },
    scanned: { conversations: 1, operatorMessages: 2 },
    found: { total: 0, byState: { completed: 0, "in-flight": 0, stalled: 0, untracked: 0, "awaiting-confirmation": 0 }, fingerprints: [] },
    created: [],
    skipped: [],
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/monitor/runs", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(query = ""): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898/api/monitor/runs${query}`, { headers: { host: "127.0.0.1" } });
}

describe("monitor runs route", () => {
  test("appends a run and reads it back, so the monitor never opens the file", async () => {
    expect((await POST(post({ record: record("run-1") }))).status).toBe(200);
    expect((await POST(post({ record: record("run-2", "failed") }))).status).toBe(200);
    const payload = await (await GET(get("?limit=10"))).json() as { runs: MonitorRunRecord[] };
    expect(payload.runs.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
    expect(payload.runs[1]!.outcome).toBe("failed");
  });

  test("strips anything that is not an audit field before it reaches the journal", async () => {
    await POST(post({ record: { ...record("run-dirty"), operatorBody: SMUGGLED_BODY, cwd: SMUGGLED_PATH } }));
    const raw = fs.readFileSync(process.env.LLV_MONITOR_AUDIT_FILE!, "utf8");
    expect(raw).not.toContain(SMUGGLED_BODY);
    expect(raw).not.toContain(SMUGGLED_PATH);
  });

  test("refuses a body that is not a run record", async () => {
    expect((await POST(post({ record: { runId: "x" } }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
  });

  test("rejects a cross-origin write", async () => {
    const response = await POST(new NextRequest("http://127.0.0.1:8898/api/monitor/runs", {
      method: "POST",
      headers: { host: "127.0.0.1", origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ record: record("run-evil") }),
    }));
    expect(response.status).toBe(403);
  });

  test("bounds the page size a caller can ask for", async () => {
    const payload = await (await GET(get("?limit=99999"))).json() as { runs: MonitorRunRecord[] };
    expect(payload.runs.length).toBeLessThanOrEqual(200);
  });
});
