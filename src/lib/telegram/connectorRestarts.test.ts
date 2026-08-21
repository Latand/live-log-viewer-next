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
  confirmConnectorRestart,
  readConnectorRestarts,
  recordConnectorCrash,
  restartedWithin,
  restartsWithin,
  watchConnectorCrash,
} = await import("./connectorRestarts");

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function restartsFile(): string {
  return path.join(process.env.LLV_STATE_DIR!, "telegram", "restarts.json");
}

function recordCompletedRestart(crash: { exitCode: number | null; signal: string | null }, at: number): void {
  recordConnectorCrash(crash, at);
  confirmConnectorRestart();
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
  expect(readConnectorRestarts()).toEqual({ version: 1, restarts: 0, lastRestartAt: null, recent: [], pending: null });
  expect(restartsWithin(RESTART_COUNT_WINDOW_MS, NOW)).toBe(0);
  expect(restartedWithin(RESTART_GRACE_MS, NOW)).toBe(false);
});

test("a crash record is structured only: exit code, signal, timestamp", () => {
  recordConnectorCrash({ exitCode: null, signal: "SIGKILL" }, NOW);
  /* The connector's stderr can carry chat titles and message text. The record
     has exactly three fields, and none of them is output. */
  const pending = readConnectorRestarts().pending!;
  expect(Object.keys(pending).sort()).toEqual(["at", "exitCode", "signal"]);
  expect(pending).toEqual({ at: new Date(NOW).toISOString(), exitCode: null, signal: "SIGKILL" });
  expect(fs.statSync(restartsFile()).mode & 0o077).toBe(0);
});

test("a detected crash is persisted at once but is not yet a counted restart", () => {
  recordConnectorCrash({ exitCode: 139, signal: null }, NOW);
  const detected = readConnectorRestarts();
  expect(detected.pending).not.toBeNull();
  /* The respawn has not verified yet, so nothing the operator reads as a
     completed restart has happened. */
  expect(detected.restarts).toBe(0);
  expect(detected.lastRestartAt).toBeNull();
  expect(restartsWithin(RESTART_COUNT_WINDOW_MS, NOW, detected)).toBe(0);
  expect(restartedWithin(RESTART_GRACE_MS, NOW, detected)).toBe(false);
});

test("a replacement that verifies turns the detected crash into one counted restart", () => {
  recordConnectorCrash({ exitCode: 139, signal: null }, NOW);
  confirmConnectorRestart();
  const state = readConnectorRestarts();
  expect(state.restarts).toBe(1);
  expect(state.pending).toBeNull();
  /* Timed from the death, so the grace window covers the calls it dropped. */
  expect(state.lastRestartAt).toBe(new Date(NOW).toISOString());
  expect(state.recent[0]).toEqual({ at: new Date(NOW).toISOString(), exitCode: 139, signal: null });
});

test("a respawn that never verifies is never counted as a completed restart", () => {
  recordConnectorCrash({ exitCode: 137, signal: null }, NOW);
  /* Retry after retry, with no replacement ever answering: the crash stays
     detected, and the panel keeps showing zero completed restarts. */
  recordConnectorCrash({ exitCode: 137, signal: null }, NOW + 1_000);
  expect(readConnectorRestarts().restarts).toBe(0);
  /* The first detection wins, so the exit code the watched child reported is
     not overwritten by a later sweep that has none. */
  expect(readConnectorRestarts().pending).toEqual({ at: new Date(NOW).toISOString(), exitCode: 137, signal: null });
});

test("confirming without a detected crash is a no-op: a first spawn is not a restart", () => {
  confirmConnectorRestart();
  expect(readConnectorRestarts()).toEqual({ version: 1, restarts: 0, lastRestartAt: null, recent: [], pending: null });
});

test("the count the panel shows is the last 24 h; the total keeps every restart", () => {
  recordCompletedRestart({ exitCode: 1, signal: null }, NOW - 30 * HOUR);
  recordCompletedRestart({ exitCode: 1, signal: null }, NOW - 20 * HOUR);
  recordCompletedRestart({ exitCode: null, signal: "SIGKILL" }, NOW - 5_000);
  const state = readConnectorRestarts();
  expect(state.restarts).toBe(3);
  expect(state.lastRestartAt).toBe(new Date(NOW - 5_000).toISOString());
  expect(restartsWithin(RESTART_COUNT_WINDOW_MS, NOW, state)).toBe(2);
});

test("the grace window is what makes a dropped call readable as a restart", () => {
  recordCompletedRestart({ exitCode: null, signal: "SIGKILL" }, NOW);
  expect(restartedWithin(RESTART_GRACE_MS, NOW + 29_000)).toBe(true);
  expect(restartedWithin(RESTART_GRACE_MS, NOW + 31_000)).toBe(false);
});

test("only an exit the Viewer did not ask for is detected as a crash", () => {
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
  expect(readConnectorRestarts().pending).toBeNull();

  watchConnectorCrash(child, () => false, () => NOW);
  listeners.pop()!(139, null);
  expect(readConnectorRestarts().pending).toEqual({ at: new Date(NOW).toISOString(), exitCode: 139, signal: null });
});

test("an adopted connector with no exit channel is watched without throwing", () => {
  expect(() => watchConnectorCrash({}, () => false, () => NOW)).not.toThrow();
  expect(readConnectorRestarts().pending).toBeNull();
});

test("corrupt state degrades to no restarts instead of breaking status", () => {
  fs.mkdirSync(path.dirname(restartsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(restartsFile(), "{not json", { mode: 0o600 });
  expect(readConnectorRestarts().restarts).toBe(0);
  /* And the next real restart still lands. */
  recordCompletedRestart({ exitCode: 0, signal: null }, NOW);
  expect(readConnectorRestarts().restarts).toBe(1);
});
