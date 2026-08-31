import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeJournal } from "./journal";
import {
  inspectRuntimeJournalFreelist,
  runtimeJournalVacuumDue,
  spawnRuntimeJournalVacuum,
} from "./journalVacuum";

test("the vacuum policy admits the incident freelist and rejects small or recent churn", () => {
  const incident = {
    pageSize: 4_096,
    pageCount: 484_031,
    freelistPages: 438_132,
    autoVacuum: 0,
    lastVacuumAt: null,
  };
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  expect(runtimeJournalVacuumDue(incident, now)).toBe(true);
  expect(runtimeJournalVacuumDue({ ...incident, freelistPages: 100 }, now)).toBe(false);
  expect(runtimeJournalVacuumDue({ ...incident, lastVacuumAt: now - 1_000 }, now)).toBe(false);
});

test("the maintenance child reclaims compacted event pages without changing the retained tail", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-vacuum-"));
  const filename = path.join(directory, "events.sqlite");
  const journal = new RuntimeJournal(filename, { maxEvents: 1_000 });
  for (let index = 0; index < 512; index += 1) {
    journal.append({
      scope: { type: "session", id: "conversation_retained" },
      kind: "delta",
      payload: {
        conversationId: "conversation_retained",
        turnId: "turn-retained",
        text: `${index}:${"x".repeat(8 * 1_024)}`,
      },
    });
  }
  journal.compact(12);

  const before = inspectRuntimeJournalFreelist(filename);
  const beforeBytes = fs.statSync(filename).size;
  expect(before.freelistPages).toBeGreaterThan(0);

  await spawnRuntimeJournalVacuum(filename);
  const after = inspectRuntimeJournalFreelist(filename);
  const database = new Database(filename, { readonly: true });
  const eventCount = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()!.count;
  database.close();

  expect(eventCount).toBe(12);
  expect(journal.replay(journal.snapshot().retentionFloorSeq).events).toHaveLength(12);
  expect(after.freelistPages).toBeLessThan(before.freelistPages);
  expect(fs.statSync(filename).size).toBeLessThan(beforeBytes);
  expect(after.autoVacuum).toBe(2);

  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
