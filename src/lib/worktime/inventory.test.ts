import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverFullTranscriptInventory } from "@/lib/scanner/discover";

test("historical inventory spans every configured root without the board scheme cap", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worktime-inventory-"));
  const rootA = path.join(directory, "account-a");
  const rootB = path.join(directory, "account-b");
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  try {
    for (let index = 0; index < 85; index += 1) {
      fs.writeFileSync(path.join(rootA, `session-${index}.jsonl`), "{}\n");
    }
    fs.writeFileSync(path.join(rootB, "mirror.jsonl"), "{}\n");

    const inventory = await discoverFullTranscriptInventory([
      ["codex-sessions", rootA],
      ["codex-sessions", rootB],
    ]);

    expect(inventory.complete).toBe(true);
    expect(inventory.files).toHaveLength(86);
    expect(new Set(inventory.files.map((entry) => entry.rootPath))).toEqual(new Set([rootA, rootB]));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
