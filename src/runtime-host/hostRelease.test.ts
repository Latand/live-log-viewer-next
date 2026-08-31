import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearRuntimeHostHandoffIntentIfMatches,
  clearRuntimeHostRollbackIntent,
  clearRuntimeHostHandoffIntent,
  currentRuntimeHostGeneration,
  readRuntimeHostHandoffIntent,
  readRuntimeHostRelease,
  readRuntimeHostRollbackIntent,
  readRuntimeHostRollbackTarget,
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  writeRuntimeHostHandoffIntent,
  writeRuntimeHostRollbackIntent,
  writeRuntimeHostRollbackTarget,
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

test("issue 1270: rollback target and intent survive the requesting executor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollback-intent-"));
  try {
    const targetFile = path.join(dir, "runtime-host-rollback-target.json");
    const intentFile = path.join(dir, "runtime-host-rollback-intent.json");
    const previous = { ...record, image: "agent-log-viewer:previous", revision: "a".repeat(40), container: "runtime-host-previous" };
    const target = {
      version: 1 as const,
      active: record,
      previous,
      predecessorId: "retained-predecessor-id",
      recordedAt: "2026-08-31T14:00:10.000Z",
    };
    const intent = { ...target, phase: "requested" as const, requestedAt: "2026-08-31T14:00:20.000Z" };

    writeRuntimeHostRollbackTarget(target, targetFile);
    writeRuntimeHostRollbackIntent(intent, intentFile);

    expect(readRuntimeHostRollbackTarget(targetFile)).toEqual(target);
    expect(readRuntimeHostRollbackIntent(intentFile)).toEqual(intent);
    clearRuntimeHostRollbackIntent(intentFile);
    expect(readRuntimeHostRollbackIntent(intentFile)).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 1270: rollback cleanup clears only its exact durable handoff intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollback-handoff-clear-"));
  try {
    const filename = path.join(dir, "runtime-host-handoff-intent.json");
    const previous = {
      ...record,
      image: "agent-log-viewer:previous",
      revision: "a".repeat(40),
      container: "runtime-host-previous",
    };
    const expected: RuntimeHostHandoffIntent = {
      revision: record.revision,
      image: record.image,
      successorContainer: record.container,
      predecessorId: "retained-predecessor-id",
      previousRelease: previous,
      successorRelease: record,
      recordedAt: "2026-08-31T14:00:10.000Z",
    };
    const later: RuntimeHostHandoffIntent = {
      ...expected,
      revision: "c".repeat(40),
      image: "agent-log-viewer:later",
      successorContainer: "runtime-host-later",
      successorRelease: {
        ...record,
        revision: "c".repeat(40),
        image: "agent-log-viewer:later",
        container: "runtime-host-later",
      },
      recordedAt: "2026-08-31T14:01:00.000Z",
    };

    writeRuntimeHostHandoffIntent(expected, filename);
    expect(() => writeRuntimeHostHandoffIntent(later, filename))
      .toThrow("runtime-host handoff intent is already owned by another generation");
    expect(readRuntimeHostHandoffIntent(filename)).toEqual(expected);
    expect(clearRuntimeHostHandoffIntentIfMatches(expected, filename)).toBe(true);
    expect(readRuntimeHostHandoffIntent(filename)).toBeNull();

    writeRuntimeHostHandoffIntent(later, filename);
    expect(clearRuntimeHostHandoffIntentIfMatches(expected, filename)).toBe(false);
    expect(readRuntimeHostHandoffIntent(filename)).toEqual(later);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 521 review: malformed durable handoff intent fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-intent-"));
  try {
    const filename = path.join(dir, "runtime-host-handoff-intent.json");
    fs.writeFileSync(filename, JSON.stringify({ revision: record.revision, image: record.image }));
    expect(() => readRuntimeHostHandoffIntent(filename)).toThrow("runtime-host handoff intent is invalid");
    fs.writeFileSync(filename, "{broken");
    expect(() => readRuntimeHostHandoffIntent(filename)).toThrow("runtime-host handoff intent is invalid");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 521 review: malformed or unreadable durable release state fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-host-release-"));
  try {
    const filename = path.join(dir, "runtime-host-release.json");
    expect(readRuntimeHostRelease(filename)).toBeNull();
    fs.writeFileSync(filename, "{broken");
    expect(() => readRuntimeHostRelease(filename)).toThrow("runtime-host release is invalid");
    fs.writeFileSync(filename, "null");
    expect(() => readRuntimeHostRelease(filename)).toThrow("runtime-host release is invalid");
    fs.rmSync(filename);
    fs.mkdirSync(filename);
    expect(() => readRuntimeHostRelease(filename)).toThrow("runtime-host release is unreadable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("issue 521 review: unreadable durable handoff intent fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-intent-read-"));
  try {
    const filename = path.join(dir, "runtime-host-handoff-intent.json");
    fs.mkdirSync(filename);
    expect(() => readRuntimeHostHandoffIntent(filename)).toThrow("runtime-host handoff intent is unreadable");
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
