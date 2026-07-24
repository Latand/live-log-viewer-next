import { expect, test } from "bun:test";

import {
  PROD_STATE_EVIDENCE_FILES,
  prodStateChanges,
  type ProdStateFingerprint,
} from "./deploy-staging";

function fingerprint(digest: string, mtimeMs: number): ProdStateFingerprint {
  return { digest, mtimeMs };
}

test("the prod evidence set covers every state family staging must not touch", () => {
  expect([...PROD_STATE_EVIDENCE_FILES].sort()).toEqual([
    "agent-registry.json",
    "board.json",
    "flows.json",
    "pipelines.json",
    "runtime-events.sqlite",
    "viewer-release.json",
  ]);
});

test("prod state changes distinguish untouched, changed and absent files", () => {
  const before = new Map<string, ProdStateFingerprint | null>([
    ["viewer-release.json", fingerprint("aa", 1)],
    ["board.json", fingerprint("bb", 2)],
    ["pipelines.json", null],
  ]);
  const after = new Map<string, ProdStateFingerprint | null>([
    ["viewer-release.json", fingerprint("aa", 1)],
    ["board.json", fingerprint("cc", 3)],
    ["pipelines.json", null],
  ]);
  const changes = prodStateChanges(before, after);
  expect(changes.unchanged).toEqual(["pipelines.json", "viewer-release.json"]);
  expect(changes.changed).toEqual(["board.json"]);
});

test("a viewer-release change is flagged as a deploy-machinery violation", () => {
  const before = new Map<string, ProdStateFingerprint | null>([["viewer-release.json", fingerprint("aa", 1)]]);
  const after = new Map<string, ProdStateFingerprint | null>([["viewer-release.json", fingerprint("zz", 9)]]);
  expect(prodStateChanges(before, after).violation).toBe("viewer-release.json");
  expect(prodStateChanges(before, before).violation).toBeNull();
});
