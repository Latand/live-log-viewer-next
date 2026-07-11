import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousState = process.env.LLV_STATE_DIR;
const importedUnder = fs.mkdtempSync(path.join(os.tmpdir(), "llv-workflow-import-state-"));
const activeState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-workflow-active-state-"));

process.env.LLV_STATE_DIR = importedUnder;
const { loadWorkflows, saveWorkflows } = await import("./store");
process.env.LLV_STATE_DIR = activeState;

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(importedUnder, { recursive: true, force: true });
  fs.rmSync(activeState, { recursive: true, force: true });
});

test("workflow persistence follows the active state directory after module import", () => {
  saveWorkflows([]);

  expect(fs.existsSync(path.join(importedUnder, "workflows.json"))).toBe(false);
  expect(fs.existsSync(path.join(activeState, "workflows.json"))).toBe(true);
  expect(loadWorkflows()).toEqual([]);
});
