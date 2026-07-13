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
