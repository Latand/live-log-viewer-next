import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-staging-route-test-"));
const SAVED = {
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_STAGING: process.env.LLV_STAGING,
};

const { GET } = await import("./route");

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
});

test("production instances report staging=false", async () => {
  delete process.env.LLV_STAGING;
  const payload = await (await GET()).json();
  expect(payload).toEqual({ staging: false, revision: null, deployedAt: null, endpoint: null });
});

test("staging instances report the deployed staging release record", async () => {
  const state = fs.mkdtempSync(path.join(SANDBOX, "state-"));
  process.env.LLV_STAGING = "1";
  process.env.LLV_STATE_DIR = state;
  fs.writeFileSync(path.join(state, "staging-release.json"), JSON.stringify({
    revision: "c".repeat(40),
    image: `agent-log-viewer:staging-${"c".repeat(12)}`,
    endpoint: "http://127.0.0.1:8899",
    containers: { viewer: "llv-staging-viewer", runtimeHost: "llv-staging-runtime-host" },
    deployedAt: "2026-07-24T12:00:00.000Z",
  }));
  const response = await GET();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const payload = await response.json();
  expect(payload).toEqual({
    staging: true,
    revision: "c".repeat(40),
    deployedAt: "2026-07-24T12:00:00.000Z",
    endpoint: "http://127.0.0.1:8899",
  });
});

test("a staging instance without a readable release record still identifies itself", async () => {
  const state = fs.mkdtempSync(path.join(SANDBOX, "state-"));
  process.env.LLV_STAGING = "1";
  process.env.LLV_STATE_DIR = state;
  const missing = await (await GET()).json();
  expect(missing).toEqual({ staging: true, revision: null, deployedAt: null, endpoint: null });
  fs.writeFileSync(path.join(state, "staging-release.json"), "{corrupt");
  const corrupt = await (await GET()).json();
  expect(corrupt).toEqual({ staging: true, revision: null, deployedAt: null, endpoint: null });
});
