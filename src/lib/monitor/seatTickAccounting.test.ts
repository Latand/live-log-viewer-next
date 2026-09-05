import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeatTickAccounting } from "./seatTickAccounting";
import { emptySeatTickState } from "./types";

test("prepared wake survives reopening, rejects concurrent preparation and lands once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounting-"));
  try {
    const filename = path.join(dir, "state.sqlite");
    const first = new SeatTickAccounting(filename, "project");
    first.initialize(emptySeatTickState(), null);
    const before = first.readState();
    const wake = { clientMessageId: "original", conversationId: ["conversation", "seat"].join("_"), seatEpoch: 1,
      operationId: null, text: "frozen payload", commit: { proposal: false, reasons: [], fingerprint: "one", eventsThrough: 0, children: [] } };
    expect(first.prepare(before, wake)).toBe(true);
    const reopened = new SeatTickAccounting(filename, "project");
    expect(reopened.readState().outstandingWake).toEqual(wake);
    expect(reopened.prepare(before, { ...wake, clientMessageId: "replacement" })).toBe(false);
    expect(() => first.writeState(before)).toThrow("stale");
    expect(reopened.settle("wrong-key", reopened.readState(), true)).toBe(false);
    expect(reopened.readState().outstandingWake).toEqual(wake);
    expect(reopened.settle("original", { ...reopened.readState(), lastWakeAt: "2026-09-05T12:00:00.000Z" }, true)).toBe(true);
    expect(first.settle("original", before, true)).toBe(false);
    expect(first.readState().lastWakeAt).toBe("2026-09-05T12:00:00.000Z");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
