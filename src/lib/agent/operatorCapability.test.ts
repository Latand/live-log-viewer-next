import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureOperatorSpawnCapability,
  OperatorSpawnCapabilityError,
  operatorSpawnCapabilityPath,
  rotateOperatorSpawnCapability,
} from "./operatorCapability";

const sandboxes: string[] = [];
const previousStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function stateDir(): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-capability-"));
  sandboxes.push(sandbox);
  const state = path.join(sandbox, "state");
  process.env.LLV_STATE_DIR = state;
  return state;
}

test("viewer mints one durable owner-readable operator spawn capability", () => {
  const state = stateDir();

  const first = ensureOperatorSpawnCapability();
  const second = ensureOperatorSpawnCapability();
  const capabilityPath = operatorSpawnCapabilityPath();

  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).toBe(first);
  expect(capabilityPath).toBe(path.join(state, "operator-spawn-capability"));
  expect(fs.readFileSync(capabilityPath, "utf8")).toBe(`${first}\n`);
  expect(fs.statSync(capabilityPath).mode & 0o777).toBe(0o600);
});

test("operator spawn capability rotation replaces the token and leaves settings untouched", () => {
  const state = stateDir();
  const settingsPath = path.join(path.dirname(state), "settings.json");
  const settings = '{"theme":"operator-choice"}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, settings);
  const first = ensureOperatorSpawnCapability();

  const rotated = rotateOperatorSpawnCapability();

  expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(rotated).not.toBe(first);
  expect(fs.readFileSync(operatorSpawnCapabilityPath(), "utf8")).toBe(`${rotated}\n`);
  expect(fs.statSync(operatorSpawnCapabilityPath()).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(settingsPath, "utf8")).toBe(settings);
});

test("operator capability state I/O failures surface an actionable error", () => {
  const state = stateDir();
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "state path is blocked\n");

  expect(() => ensureOperatorSpawnCapability()).toThrow(OperatorSpawnCapabilityError);
  expect(() => ensureOperatorSpawnCapability()).toThrow("capability read failed");
  expect(() => rotateOperatorSpawnCapability()).toThrow(OperatorSpawnCapabilityError);
  expect(() => rotateOperatorSpawnCapability()).toThrow("capability write failed");
});
