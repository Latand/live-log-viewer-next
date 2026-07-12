import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { readAuthorshipEvidence, readUserAuthoredPaths } from "@/lib/reaperAuthorship";

const stateFile = () => statePath("reaper-state.json");

afterEach(() => fs.rmSync(stateFile(), { force: true }));

function writeState(value: unknown): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(value), "utf8");
}

test("reads the sticky userAuthoredPaths map as a set", () => {
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true, "/b": true } });
  expect(readUserAuthoredPaths()).toEqual(new Set(["/a", "/b"]));
});

test("missing state file yields an empty set", () => {
  fs.rmSync(stateFile(), { force: true });
  expect(readUserAuthoredPaths()).toEqual(new Set());
});

test("corrupt or shapeless state yields an empty set", () => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), "{ not json", "utf8");
  expect(readUserAuthoredPaths()).toEqual(new Set());
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: ["/a"] });
  expect(readUserAuthoredPaths()).toEqual(new Set());
  writeState({ version: 1 });
  expect(readUserAuthoredPaths()).toEqual(new Set());
});

test("evidence exposes the reaper's last-run time from the state file mtime", () => {
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true } });
  const before = fs.statSync(stateFile()).mtimeMs / 1000;
  const evidence = readAuthorshipEvidence();
  expect(evidence.userAuthoredPaths).toEqual(new Set(["/a"]));
  expect(evidence.observedAtSec).not.toBeNull();
  expect(Math.abs(evidence.observedAtSec! - before)).toBeLessThan(2);
});

test("missing state file reports no observation time (fail closed)", () => {
  fs.rmSync(stateFile(), { force: true });
  const evidence = readAuthorshipEvidence();
  expect(evidence.observedAtSec).toBeNull();
  expect(evidence.userAuthoredPaths.size).toBe(0);
});

test("reads the path-scoped scannedAt freshness map, dropping non-number stamps", () => {
  writeState({
    version: 1,
    firstObservedAt: {},
    userAuthoredPaths: {},
    scannedAt: { "/a": 1000, "/b": 2000.5, "/bad": "nope", "/nan": Number.NaN },
  });
  const evidence = readAuthorshipEvidence();
  expect(evidence.scannedAt).toEqual(new Map([["/a", 1000], ["/b", 2000.5]]));
});

test("missing or shapeless scannedAt yields an empty freshness map (fail closed)", () => {
  fs.rmSync(stateFile(), { force: true });
  expect(readAuthorshipEvidence().scannedAt).toEqual(new Map());
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: {}, scannedAt: ["/a"] });
  expect(readAuthorshipEvidence().scannedAt).toEqual(new Map());
  writeState({ version: 1, firstObservedAt: {}, userAuthoredPaths: {} });
  expect(readAuthorshipEvidence().scannedAt).toEqual(new Map());
});

test("does not touch the caller's temp dir isolation", () => {
  /* The suite pins LLV_STATE_DIR to a throwaway temp dir; confirm the reader
     resolves under it and never falls back to the real config dir. */
  expect(stateFile().startsWith(os.tmpdir())).toBe(true);
});
