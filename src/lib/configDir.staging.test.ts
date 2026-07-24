import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-configdir-staging-test-"));
const SAVED = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_STAGING: process.env.LLV_STAGING,
};

const { inboxDir, stateDir, statePath } = await import("./configDir");

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("staging mode pins the state dir to its own state-staging default", () => {
  const xdg = path.join(SANDBOX, "xdg-default");
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.LLV_STAGING = "1";
  delete process.env.LLV_STATE_DIR;
  expect(stateDir()).toBe(path.join(xdg, "agent-log-viewer", "state-staging"));
  expect(statePath("agent-registry.json"))
    .toBe(path.join(xdg, "agent-log-viewer", "state-staging", "agent-registry.json"));
});

test("staging mode never migrates or copies prod legacy state", () => {
  const xdg = path.join(SANDBOX, "xdg-no-migration");
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.LLV_STAGING = "1";
  delete process.env.LLV_STATE_DIR;
  const resolved = stateDir();
  /* The legacy migration copies ~/.claude/viewer-state and stamps a sentinel.
     Staging resolution must be pure: no dir creation, no sentinel, no copy. */
  expect(fs.existsSync(resolved)).toBe(false);
  expect(fs.existsSync(path.join(xdg, "agent-log-viewer", "state"))).toBe(false);
});

test("staging mode refuses the production state dir", () => {
  const xdg = path.join(SANDBOX, "xdg-prod-clash");
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.LLV_STAGING = "1";
  process.env.LLV_STATE_DIR = path.join(xdg, "agent-log-viewer", "state");
  expect(() => stateDir()).toThrow(/staging/i);
  process.env.LLV_STATE_DIR = path.join(xdg, "agent-log-viewer", "state", "");
  expect(() => stateDir()).toThrow(/staging/i);
});

test("staging mode refuses the legacy viewer-state dirs", () => {
  process.env.LLV_STAGING = "1";
  process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "xdg-legacy-clash");
  process.env.LLV_STATE_DIR = path.join(os.homedir(), ".claude", "viewer-state");
  expect(() => stateDir()).toThrow(/staging/i);
  process.env.LLV_STATE_DIR = path.join(path.join(SANDBOX, "xdg-legacy-clash"), "live-log-viewer", "state");
  expect(() => stateDir()).toThrow(/staging/i);
});

test("staging mode accepts an explicit non-prod override", () => {
  process.env.LLV_STAGING = "1";
  process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "xdg-override");
  process.env.LLV_STATE_DIR = path.join(SANDBOX, "elsewhere", "staging-state");
  expect(stateDir()).toBe(path.join(SANDBOX, "elsewhere", "staging-state"));
});

test("staging mode keeps the inbox inside the staging state dir", () => {
  const xdg = path.join(SANDBOX, "xdg-inbox");
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.LLV_STAGING = "1";
  delete process.env.LLV_STATE_DIR;
  expect(inboxDir()).toBe(path.join(xdg, "agent-log-viewer", "state-staging", "inbox"));
  expect(fs.existsSync(path.join(xdg, "agent-log-viewer", "inbox"))).toBe(false);
});
