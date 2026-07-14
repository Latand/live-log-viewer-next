import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { adoptOrchestratorRecord, ORCHESTRATOR_SCHEMA_VERSION, orchestratorRecordExists, readOrchestratorRecord, type OrchestratorRecord } from "./store";

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orchestrator-store-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function record(conversationId: string, transcriptPath: string | null): OrchestratorRecord {
  return { conversationId, path: transcriptPath, createdAt: "2026-07-14T00:00:00.000Z" };
}

test("first adoption wins and round-trips through the state file", () => {
  expect(readOrchestratorRecord()).toBeNull();
  const first = adoptOrchestratorRecord(record("conv-1", null));
  expect(first).toEqual({ record: record("conv-1", null), adopted: true });
  expect(JSON.parse(fs.readFileSync(path.join(sandbox, "orchestrator.json"), "utf8"))).toMatchObject({ schemaVersion: ORCHESTRATOR_SCHEMA_VERSION });
  expect(readOrchestratorRecord()).toEqual(record("conv-1", null));

  const loser = adoptOrchestratorRecord(record("conv-2", null));
  expect(loser).toEqual({ record: record("conv-1", null), adopted: false });
});

test("re-adopting the same conversation refreshes its record", () => {
  adoptOrchestratorRecord(record("conv-1", null));
  const transcript = path.join(sandbox, "conv-1.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  const again = adoptOrchestratorRecord(record("conv-1", transcript));
  expect(again).toEqual({ record: record("conv-1", transcript), adopted: true });
});

test("a deleted transcript releases the single-instance slot", () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  adoptOrchestratorRecord(record("conv-1", transcript));
  expect(orchestratorRecordExists(record("conv-1", transcript))).toBe(true);

  fs.rmSync(transcript);
  expect(orchestratorRecordExists(record("conv-1", transcript))).toBe(false);
  const replacement = adoptOrchestratorRecord(record("conv-2", null));
  expect(replacement).toEqual({ record: record("conv-2", null), adopted: true });
});

test("a record without a settled transcript path counts as live", () => {
  expect(orchestratorRecordExists(record("conv-1", null))).toBe(true);
});

test("malformed and future-schema files read as absent so adoption recovers", () => {
  const file = path.join(sandbox, "orchestrator.json");
  for (const content of ["{", JSON.stringify({ schemaVersion: ORCHESTRATOR_SCHEMA_VERSION + 1, record: record("conv-1", null) })]) {
    fs.writeFileSync(file, content, "utf8");
    expect(readOrchestratorRecord()).toBeNull();
  }
  const recovered = adoptOrchestratorRecord(record("conv-2", null));
  expect(recovered.adopted).toBe(true);
  expect(readOrchestratorRecord()).toEqual(record("conv-2", null));
});
