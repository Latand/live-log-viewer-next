import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSessionTitles } from "./titleStore";

let stateDir = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-titles-ipc-"));
  process.env.LLV_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("concurrent writers in separate processes never lose an update", async () => {
  const child = path.join(import.meta.dir, "titleStore.lockChild.ts");
  const WRITERS = 4;
  const PER_WRITER = 12;
  const env = { ...process.env, LLV_STATE_DIR: stateDir };

  // Each process runs many read-modify-write cycles against the shared file;
  // without the interprocess lock, interleaved cycles drop keys. The lock must
  // serialize them so every distinct key survives.
  const children = Array.from({ length: WRITERS }, (_unused, writer) =>
    Bun.spawn({
      cmd: [process.execPath, child, String(writer), String(PER_WRITER)],
      env,
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(children.map(async (proc) => ({
    code: await proc.exited,
    stderr: await new Response(proc.stderr).text(),
  })));
  for (const result of results) {
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  }

  const records = loadSessionTitles();
  expect(records).toHaveLength(WRITERS * PER_WRITER);
  for (let writer = 0; writer < WRITERS; writer += 1) {
    for (let index = 0; index < PER_WRITER; index += 1) {
      expect(records.some((record) => record.key === `path:/w${writer}/${index}`)).toBe(true);
    }
  }
});
