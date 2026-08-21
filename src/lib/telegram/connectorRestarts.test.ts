import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Isolated state: this suite must never read or write the operator's own
   Telegram connector state. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-restarts-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const {
  RESTART_COUNT_WINDOW_MS,
  RESTART_GRACE_MS,
  readConnectorRestarts,
  recordConnectorRestart,
  restartedWithin,
  restartsWithin,
  watchConnectorCrash,
} = await import("./connectorRestarts");

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function restartsFile(): string {
  return path.join(process.env.LLV_STATE_DIR!, "telegram", "restarts.json");
}

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("no state at all reads as no restarts, never as a failure", () => {
  expect(readConnectorRestarts()).toEqual({ version: 1, restarts: 0, lastRestartAt: null, recent: [] });
  expect(restartsWithin(RESTART_COUNT_WINDOW_MS, NOW)).toBe(0);
  expect(restartedWithin(RESTART_GRACE_MS, NOW)).toBe(false);
});

test("a crash record is structured only: exit code, signal, timestamp", () => {
  recordConnectorRestart({ exitCode: null, signal: "SIGKILL" }, NOW);
  const state = readConnectorRestarts();
  expect(state.restarts).toBe(1);
  expect(state.lastRestartAt).toBe(new Date(NOW).toISOString());
  /* The connector's stderr can carry chat titles and message text. The record
     has exactly three fields, and none of them is output. */
  expect(Object.keys(state.recent[0]!).sort()).toEqual(["at", "exitCode", "signal"]);
  expect(state.recent[0]).toEqual({ at: new Date(NOW).toISOString(), exitCode: null, signal: "SIGKILL" });
  expect(fs.statSync(restartsFile()).mode & 0o077).toBe(0);
});

test("the count the panel shows is the last 24 h; the total keeps every restart", () => {
  recordConnectorRestart({ exitCode: 1, signal: null }, NOW - 30 * HOUR);
  recordConnectorRestart({ exitCode: 1, signal: null }, NOW - 20 * HOUR);
  recordConnectorRestart({ exitCode: null, signal: "SIGKILL" }, NOW - 5_000);
  const state = readConnectorRestarts();
  expect(state.restarts).toBe(3);
  expect(state.lastRestartAt).toBe(new Date(NOW - 5_000).toISOString());
  expect(restartsWithin(RESTART_COUNT_WINDOW_MS, NOW, state)).toBe(2);
});

test("the grace window is what makes a dropped call readable as a restart", () => {
  recordConnectorRestart({ exitCode: null, signal: "SIGKILL" }, NOW);
  expect(restartedWithin(RESTART_GRACE_MS, NOW + 29_000)).toBe(true);
  expect(restartedWithin(RESTART_GRACE_MS, NOW + 31_000)).toBe(false);
});

test("only an exit the Viewer did not ask for counts as a restart", () => {
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const child = {
    once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      listeners.push(listener);
      return this;
    },
  };

  /* A logout, a health-check stop or an operator disconnect terminates the
     connector on purpose — that is not a crash. */
  watchConnectorCrash(child, () => true, () => NOW);
  listeners.pop()!(null, "SIGTERM");
  expect(readConnectorRestarts().restarts).toBe(0);

  watchConnectorCrash(child, () => false, () => NOW);
  listeners.pop()!(139, null);
  expect(readConnectorRestarts().recent[0]).toEqual({ at: new Date(NOW).toISOString(), exitCode: 139, signal: null });
});

test("an adopted connector with no exit channel is watched without throwing", () => {
  expect(() => watchConnectorCrash({}, () => false, () => NOW)).not.toThrow();
  expect(readConnectorRestarts().restarts).toBe(0);
});

test("corrupt state degrades to no restarts instead of breaking status", () => {
  fs.mkdirSync(path.dirname(restartsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(restartsFile(), "{not json", { mode: 0o600 });
  expect(readConnectorRestarts().restarts).toBe(0);
  /* And the next real restart still lands. */
  recordConnectorRestart({ exitCode: 0, signal: null }, NOW);
  expect(readConnectorRestarts().restarts).toBe(1);
});
