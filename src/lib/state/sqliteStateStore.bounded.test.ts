import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStateCollections, SqliteStateCollection } from "./sqliteStateStore";
import { publishHotStateAuthority } from "./hotStateAuthority";

type Row = { key: string; value: number };
test("bounded collection pages and conditional patches stay atomic across independent connections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-store-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const options = { collection: "bounded-test", schemaVersion: 1, busyMessage: "busy", key: (row: Row) => row.key,
      decode: (raw: unknown) => raw as Row, clone: (row: Row) => ({ ...row }) };
    initializeStateCollections(filename, [{ ...options, migrationId: "one", loadRecords: () => [] }]);
    const first = new SqliteStateCollection(filename, options);
    const second = new SqliteStateCollection(filename, options);
    for (let batch = 0; batch < 10; batch++) first.boundedPatch(500, (tx) => {
      for (let n = batch * 500; n < (batch + 1) * 500; n++) tx.put({ key: `outcome/${String(n).padStart(6, "0")}`, value: n });
    });
    expect(first.keyRange("outcome/", "outcome/~", 3).map((row) => row.value)).toEqual([0, 1, 2]);
    expect(first.keyRange("outcome/000002", "outcome/~", 2).map((row) => row.value)).toEqual([3, 4]);
    const update = (store: typeof first) => store.boundedPatch(2, (tx) => {
      const held = tx.get("outcome/000000")!;
      if (held.value !== 0) return false;
      tx.put({ ...held, value: 100 });
      return true;
    });
    expect(update(first)).toBe(true);
    expect(update(second)).toBe(false);
    expect(() => first.boundedPatch(1, (tx) => {
      tx.put({ key: "rolled-back", value: 1 });
      tx.put({ key: "never", value: 2 });
    })).toThrow("budget exceeded");
    expect(second.get("rolled-back")).toBeNull();
    expect(() => first.boundedPatch(2, (tx) => { tx.delete("outcome/000000"); throw new Error("crash"); })).toThrow("crash");
    expect(second.get("outcome/000000")?.value).toBe(100);
    expect(() => first.boundedPatch(1, (tx) => {
      tx.put({ key: "authority-race", value: 1 });
      fs.writeFileSync(path.join(dir, "viewer-release.json"), JSON.stringify({ revision: "b".repeat(40), endpoint: "http://127.0.0.1:19004", hotStateBackend: "sqlite-v1" }));
      publishHotStateAuthority(dir, "fencing", "b".repeat(40));
    })).toThrow("fenced");
    expect(second.get("authority-race")).toBeNull();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
