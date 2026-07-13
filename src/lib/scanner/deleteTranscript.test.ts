import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeProjectTranscriptsFromDisk } from "./deleteTranscript";

test("bulk transcript staging rolls every path back when the commit cannot complete", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-project-delete-"));
  const present = path.join(dir, "present.jsonl");
  const missing = path.join(dir, "missing.jsonl");
  await fs.writeFile(present, "session\n");
  try {
    await expect(removeProjectTranscriptsFromDisk([present, missing])).rejects.toThrow();
    expect(await fs.readFile(present, "utf8")).toBe("session\n");
    expect((await fs.readdir(dir)).some((name) => name.includes(".llv-delete-"))).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bulk transcript cleanup restores a failed item and continues the remaining cleanup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-project-cleanup-"));
  const first = path.join(dir, "first.jsonl");
  const second = path.join(dir, "second.jsonl");
  await fs.writeFile(first, "first\n");
  await fs.writeFile(second, "second\n");
  let removals = 0;
  try {
    await expect(removeProjectTranscriptsFromDisk([first, second], {
      rename: fs.rename,
      rm: async (...args: Parameters<typeof fs.rm>) => {
        removals += 1;
        if (removals === 1) throw new Error("injected cleanup failure");
        return fs.rm(...args);
      },
    })).rejects.toThrow("project deletion cleanup failed");
    expect(await fs.readFile(first, "utf8")).toBe("first\n");
    expect(await fs.stat(second).then(() => true, () => false)).toBe(false);
    expect((await fs.readdir(dir)).some((name) => name.includes(".llv-delete-"))).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
