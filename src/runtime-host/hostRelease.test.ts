import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearRuntimeHostHandoffIntent,
  currentRuntimeHostGeneration,
  readRuntimeHostHandoffIntent,
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  writeRuntimeHostHandoffIntent,
  type RuntimeHostHandoffIntent,
  type RuntimeHostReleaseRecord,
} from "./hostRelease";

const record: RuntimeHostReleaseRecord = {
  image: "agent-log-viewer:deploy-candidate",
  revision: "b".repeat(40),
  container: "llv-runtime-host-bbbbbbbbbbbb",
  endpoint: "http://127.0.0.1:8898",
  stagedAt: "2026-07-21T09:00:00.000Z",
};

test("issue 518: a process claims the durable generation only with matching container identity", () => {
  expect(currentRuntimeHostGeneration({
    NODE_ENV: "test",
    [RUNTIME_HOST_IMAGE_ENV]: record.image,
    [RUNTIME_HOST_REVISION_ENV]: record.revision,
    [RUNTIME_HOST_CONTAINER_ENV]: record.container,
  }, record)).toEqual({ image: record.image, revision: record.revision });
});

/* PR #521 review, finding 1: the handoff intent is the durable intermediate
   identity that survives a client-process crash between the predecessor's
   restart-policy disable and the release publication. */
test("issue 521: the handoff intent round-trips durably and clears idempotently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-intent-"));
  try {
    const filename = path.join(dir, "runtime-host-handoff-intent.json");
    expect(readRuntimeHostHandoffIntent(filename)).toBeNull();
    const intent: RuntimeHostHandoffIntent = {
      revision: record.revision,
      image: record.image,
      successorContainer: record.container,
      predecessorId: "abc123",
      recordedAt: "2026-07-21T09:00:00.000Z",
    };
    writeRuntimeHostHandoffIntent(intent, filename);
    expect(readRuntimeHostHandoffIntent(filename)).toEqual(intent);
    clearRuntimeHostHandoffIntent(filename);
    expect(readRuntimeHostHandoffIntent(filename)).toBeNull();
    clearRuntimeHostHandoffIntent(filename);
    expect(readRuntimeHostHandoffIntent(filename)).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 521: an invalid handoff intent reads as absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-intent-"));
  try {
    const filename = path.join(dir, "runtime-host-handoff-intent.json");
    fs.writeFileSync(filename, JSON.stringify({ revision: record.revision, image: record.image }));
    expect(readRuntimeHostHandoffIntent(filename)).toBeNull();
    fs.writeFileSync(filename, "{broken");
    expect(readRuntimeHostHandoffIntent(filename)).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 518: a predecessor cannot claim the successor release record", () => {
  expect(currentRuntimeHostGeneration({ NODE_ENV: "test" }, record)).toEqual({ image: null, revision: null });
  expect(currentRuntimeHostGeneration({
    NODE_ENV: "test",
    [RUNTIME_HOST_IMAGE_ENV]: "agent-log-viewer:stale",
    [RUNTIME_HOST_REVISION_ENV]: record.revision,
    [RUNTIME_HOST_CONTAINER_ENV]: record.container,
  }, record)).toEqual({ image: null, revision: null });
});
