import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-lock-route-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_MONITOR_AUDIT_FILE: process.env.LLV_MONITOR_AUDIT_FILE };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
process.env.LLV_MONITOR_AUDIT_FILE = path.join(SANDBOX, "journal", "runs.ndjson");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { POST } = await import("./route");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type LockPayload = { claimed?: boolean; token?: string; detail?: string; released?: boolean; error?: string };

function post(body: unknown, origin?: string): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/monitor/lock", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

async function call(body: unknown): Promise<LockPayload> {
  return await (await POST(post(body))).json() as LockPayload;
}

describe("monitor lock route", () => {
  test("grants the lock once, then reports who holds it", async () => {
    const first = await call({ action: "claim" });
    expect(first.claimed).toBe(true);
    expect(typeof first.token).toBe("string");

    const second = await call({ action: "claim" });
    expect(second.claimed).toBe(false);
    expect(second.detail).toContain("lock");

    expect((await call({ action: "release", token: "not-the-token" })).released).toBe(false);
    expect((await call({ action: "release", token: first.token })).released).toBe(true);
    expect((await call({ action: "claim" })).claimed).toBe(true);
  });

  test("a release needs a token", async () => {
    expect((await POST(post({ action: "release" }))).status).toBe(400);
  });

  test("an unknown action is refused", async () => {
    expect((await POST(post({ action: "steal" }))).status).toBe(400);
  });

  test("rejects a cross-origin claim", async () => {
    expect((await POST(post({ action: "claim" }, "https://evil.example"))).status).toBe(403);
  });
});
