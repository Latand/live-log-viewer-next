import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptOrchestratorRecord,
  MANAGER_DEFAULT_ENGINE,
  MANAGER_DEFAULT_MODEL,
  ORCHESTRATOR_SCHEMA_VERSION,
  orchestratorRecordExists,
  readOrchestratorRecord,
  rekeyOrchestratorRecordPath,
  replaceOrchestratorIncumbent,
  type OrchestratorRecord,
} from "./store";

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
  return {
    conversationId,
    path: transcriptPath,
    createdAt: "2026-07-14T00:00:00.000Z",
    engine: MANAGER_DEFAULT_ENGINE,
    model: MANAGER_DEFAULT_MODEL,
  };
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

/* #691 §3 — the record names the incumbent's engine and model, so replacing the
   manager is a record update rather than a new identity. */

test("the manager record carries the incumbent engine and model, defaulting to Claude Opus 5", () => {
  expect(MANAGER_DEFAULT_ENGINE).toBe("claude");
  expect(MANAGER_DEFAULT_MODEL).toBe("opus");

  adoptOrchestratorRecord({ conversationId: "conv-1", path: null, createdAt: "2026-07-27T00:00:00.000Z" });
  expect(readOrchestratorRecord()).toEqual({
    conversationId: "conv-1",
    path: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    engine: "claude",
    model: "opus",
  });
});

test("a pre-#691 record reads forward with the default incumbent instead of as absent", () => {
  /* The operator already has a live orchestrator on disk. Reading a v1 file as
     "no manager" would drop that designation and spawn a second one. */
  fs.writeFileSync(
    path.join(sandbox, "orchestrator.json"),
    JSON.stringify({
      schemaVersion: 1,
      record: { conversationId: "conv-legacy", path: null, createdAt: "2026-07-14T00:00:00.000Z" },
    }),
    "utf8",
  );

  expect(readOrchestratorRecord()).toEqual({
    conversationId: "conv-legacy",
    path: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    engine: "claude",
    model: "opus",
  });
});

test("a deliberate incumbent swap replaces a live record and keeps the designation", () => {
  const transcript = path.join(sandbox, "conv-1.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  adoptOrchestratorRecord(record("conv-1", transcript));

  /* Adoption refuses this, and must: it is the guard against two orchestrators.
     A swap is a different act, so it is a different function. */
  expect(adoptOrchestratorRecord(record("conv-2", null)).adopted).toBe(false);

  const swapped = replaceOrchestratorIncumbent({
    conversationId: "conv-2",
    path: null,
    createdAt: "2026-07-27T10:00:00.000Z",
    engine: "codex",
    model: "sol",
  });
  expect(swapped).toEqual({
    conversationId: "conv-2",
    path: null,
    createdAt: "2026-07-27T10:00:00.000Z",
    engine: "codex",
    model: "sol",
  });
  expect(readOrchestratorRecord()).toEqual(swapped);
});

test("identity migration rekeys the legacy manager path idempotently and fails closed on corruption", () => {
  const legacyPath = path.join(sandbox, "legacy.jsonl");
  const sharedPath = path.join(sandbox, "shared.jsonl");
  replaceOrchestratorIncumbent(record("conv-1", legacyPath));

  rekeyOrchestratorRecordPath([{ legacyPath, sharedPath }]);
  rekeyOrchestratorRecordPath([{ legacyPath, sharedPath }]);
  expect(readOrchestratorRecord()?.path).toBe(sharedPath);

  fs.writeFileSync(path.join(sandbox, "orchestrator.json"), "{", "utf8");
  expect(() => rekeyOrchestratorRecordPath([{ legacyPath, sharedPath }])).toThrow("orchestrator record evidence is malformed");
});

test("an unusable engine or model in the file falls back rather than reading as absent", () => {
  fs.writeFileSync(
    path.join(sandbox, "orchestrator.json"),
    JSON.stringify({
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      record: { conversationId: "conv-1", path: null, createdAt: "2026-07-27T00:00:00.000Z", engine: 7, model: null },
    }),
    "utf8",
  );
  expect(readOrchestratorRecord()).toEqual({
    conversationId: "conv-1",
    path: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    engine: "claude",
    model: "opus",
  });
});
