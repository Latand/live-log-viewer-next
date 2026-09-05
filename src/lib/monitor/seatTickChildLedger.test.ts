import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLedgerCursor, readChildLedger } from "./seatTickChildLedger";

test("bounded ledger reading carries a large item across ticks and finds both completed turns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-"));
  try {
    const file = path.join(dir, "events.jsonl");
    fs.writeFileSync(file, [
      { kind: "turn-started", turnId: "first", seq: 1 },
      { kind: "item", item: { nested: { kind: "turn-ended", turnId: "fake" }, text: "x".repeat(300000) }, seq: 2 },
      { kind: "turn-ended", turnId: "first", status: "completed", seq: 3 },
      { kind: "turn-started", turnId: "second", seq: 4 },
      { kind: "turn-ended", turnId: "second", status: "error", seq: 5 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    let cursor = emptyLedgerCursor();
    const outcomes: string[] = [];
    let maxState = 0;
    for (let i = 0; i < 400; i++) {
      const read = readChildLedger(file, cursor, 1024, 2);
      expect(read.bytes).toBeLessThanOrEqual(1024);
      expect(read.records).toBeLessThanOrEqual(2);
      cursor = read.cursor;
      maxState = Math.max(maxState, JSON.stringify(cursor).length);
      outcomes.push(...read.outcomes.map((event) => event.turnId));
    }
    expect(outcomes).toEqual(["first", "second"]);
    expect(cursor.gap).toBeNull();
    expect(maxState).toBeLessThan(5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("partial tails, malformed records, missing sequences and replacement keep explicit evidence gaps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-gap-"));
  try {
    const file = path.join(dir, "events.jsonl");
    const terminal = JSON.stringify({ kind: "turn-ended", turnId: "turn", status: "completed", seq: 1 });
    fs.writeFileSync(file, terminal.slice(0, 20));
    const partial = readChildLedger(file, emptyLedgerCursor(), 1000, 10);
    expect(partial.outcomes).toEqual([]);
    fs.appendFileSync(file, terminal.slice(20) + "\n");
    const complete = readChildLedger(file, partial.cursor, 1000, 10);
    expect(complete.outcomes).toHaveLength(1);
    fs.appendFileSync(file, '{"bad":,}\n' + JSON.stringify({ kind: "turn-ended", turnId: "later", status: "error", seq: 4 }) + "\n");
    const gap = readChildLedger(file, complete.cursor, 1000, 10);
    expect(gap.cursor.gap).not.toBeNull();
    expect(gap.outcomes[0]?.turnId).toBe("later");
    fs.renameSync(file, file + ".old");
    fs.writeFileSync(file, terminal + "\n");
    const replaced = readChildLedger(file, gap.cursor, 1000, 10);
    expect(replaced.cursor.gap).toBe("ledger-replaced");
    expect(replaced.outcomes[0]?.turnId).toBe("turn");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("the byte budget counts fetched bytes when the record budget stops inside a read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-ledger-read-budget-"));
  try {
    const file = path.join(dir, "events.jsonl");
    fs.writeFileSync(file, JSON.stringify({ kind: "turn-ended", turnId: "first", status: "completed", seq: 1 }) + "\n"
      + JSON.stringify({ kind: "item", seq: 2, text: "x".repeat(40000) }) + "\n");
    const read = readChildLedger(file, emptyLedgerCursor(), 32768, 1);
    expect(read.records).toBe(1);
    expect(read.bytes).toBe(16384);
    expect(read.cursor.offset).toBeLessThan(read.bytes);
    const next = readChildLedger(file, read.cursor, 32768 - read.bytes, 1);
    expect(read.bytes + next.bytes).toBeLessThanOrEqual(32768);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
