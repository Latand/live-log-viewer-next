import { beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { FileCatalogScan } from "./index";
import {
  coordinatedFileScan,
  fileScanCoordinatorStatus,
  resetFileScanCoordinatorForTests,
  runFileCatalogScan,
  type CoordinatedScanRunner,
} from "./scanCoordinator";

beforeEach(() => {
  resetFileScanCoordinatorForTests();
});

function snapshotFor(marker: string): FileCatalogScan {
  return {
    files: [{ path: `/sessions/${marker}.jsonl`, root: "codex-sessions" } as unknown as FileEntry],
    projectCatalog: [{ project: marker, smt: 1, conversations: 1 }],
    complete: true,
  };
}

interface RecordedScan {
  intent: { persist: boolean; fresh: boolean };
  release: () => void;
}

function recordingRunner(scans: RecordedScan[], marker = "corpus"): CoordinatedScanRunner {
  return (intent) => new Promise((resolve) => {
    scans.push({ intent, release: () => resolve(snapshotFor(marker)) });
  });
}

test("simultaneous HTTP, pipeline, and account requests produce one scanner invocation", async () => {
  const scans: RecordedScan[] = [];
  const runner = recordingRunner(scans);

  const http = coordinatedFileScan({}, runner);
  const pipeline = coordinatedFileScan({ persist: true }, runner);
  const account = coordinatedFileScan({ persist: true }, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);
  // The single generation carries the union of the callers' intents.
  expect(scans[0]!.intent).toEqual({ persist: true, fresh: false });

  scans[0]!.release();
  const [httpScan, pipelineScan, accountScan] = await Promise.all([http, pipeline, account]);
  for (const scan of [httpScan, pipelineScan, accountScan]) {
    expect(scan.complete).toBe(true);
    expect(scan.files.map((file) => file.path)).toEqual(["/sessions/corpus.jsonl"]);
  }
  expect(scans).toHaveLength(1);
});

test("each consumer owns a private snapshot clone", async () => {
  const scans: RecordedScan[] = [];
  const runner = recordingRunner(scans);

  const first = coordinatedFileScan({ persist: true }, runner);
  const second = coordinatedFileScan({}, runner);
  await Promise.resolve();
  scans[0]!.release();
  const [firstScan, secondScan] = await Promise.all([first, second]);

  // A controller mutating its reconciliation copy cannot corrupt another
  // consumer's snapshot.
  firstScan.files[0]!.path = "/sessions/mutated.jsonl";
  expect(secondScan.files[0]!.path).toBe("/sessions/corpus.jsonl");
});

test("a caller joins a covering in-flight generation instead of scanning again", async () => {
  const scans: RecordedScan[] = [];
  const runner = recordingRunner(scans);

  const leader = coordinatedFileScan({ persist: true }, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  const joiner = coordinatedFileScan({}, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  scans[0]!.release();
  await Promise.all([leader, joiner]);
  expect(scans).toHaveLength(1);
});

test("an uncovered intent merges into exactly one trailing generation", async () => {
  const scans: RecordedScan[] = [];
  const runner = recordingRunner(scans);

  const plain = coordinatedFileScan({}, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);
  expect(scans[0]!.intent).toEqual({ persist: false, fresh: false });

  // Both controllers need persistence the running scan cannot provide; they
  // coalesce into one trailing generation instead of two.
  const pipeline = coordinatedFileScan({ persist: true }, runner);
  const account = coordinatedFileScan({ persist: true, fresh: true }, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  scans[0]!.release();
  await plain;
  await Promise.resolve();
  await Promise.resolve();
  expect(scans).toHaveLength(2);
  expect(scans[1]!.intent).toEqual({ persist: true, fresh: true });

  scans[1]!.release();
  const [pipelineScan, accountScan] = await Promise.all([pipeline, account]);
  expect(pipelineScan.complete).toBe(true);
  expect(accountScan.complete).toBe(true);
  expect(scans).toHaveLength(2);
});

test("a fenced caller never adopts a running generation and waits for a trailing scan", async () => {
  const scans: RecordedScan[] = [];
  const runner = recordingRunner(scans);

  const leader = coordinatedFileScan({ persist: true, fresh: true }, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  // The running generation covers the intent, but the fence requires a scan
  // that starts after this request.
  const fenced = coordinatedFileScan({ fresh: true, join: false }, runner);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  scans[0]!.release();
  await leader;
  await Promise.resolve();
  await Promise.resolve();
  expect(scans).toHaveLength(2);
  scans[1]!.release();
  expect((await fenced).complete).toBe(true);
});

test("an exclusive caller keeps its own runner and never adopts a covering scan", async () => {
  const scans: RecordedScan[] = [];
  const shared = recordingRunner(scans, "shared");

  const leader = coordinatedFileScan({ persist: true, fresh: true }, shared);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  // The running generation covers the intent, but the exclusive runner owns a
  // private scope (a pinned path) only it can produce.
  const pinnedScans: RecordedScan[] = [];
  const pinned = coordinatedFileScan({ exclusive: true, join: false }, recordingRunner(pinnedScans, "pinned"));
  await Promise.resolve();
  expect(pinnedScans).toHaveLength(0);

  scans[0]!.release();
  await leader;
  await Promise.resolve();
  await Promise.resolve();
  expect(pinnedScans).toHaveLength(1);
  pinnedScans[0]!.release();
  expect((await pinned).files.map((file) => file.path)).toEqual(["/sessions/pinned.jsonl"]);
});

test("a catalog joiner never adopts a running exclusive generation", async () => {
  const pinnedScans: RecordedScan[] = [];
  const pinned = coordinatedFileScan({ exclusive: true, join: false }, recordingRunner(pinnedScans, "pinned"));
  await Promise.resolve();
  expect(pinnedScans).toHaveLength(1);

  // The pinned scan's snapshot carries its private overlay; an ordinary
  // catalog caller must wait for a shared generation instead of adopting it.
  const scans: RecordedScan[] = [];
  const joiner = coordinatedFileScan({}, recordingRunner(scans, "shared"));
  pinnedScans[0]!.release();
  await pinned;
  await Promise.resolve();
  await Promise.resolve();
  expect(scans).toHaveLength(1);
  scans[0]!.release();
  expect((await joiner).files.map((file) => file.path)).toEqual(["/sessions/shared.jsonl"]);
});

test("later callers never merge into a queued exclusive generation", async () => {
  const scans: RecordedScan[] = [];
  const shared = recordingRunner(scans, "shared");

  const leader = coordinatedFileScan({}, shared);
  await Promise.resolve();
  expect(scans).toHaveLength(1);

  const pinnedScans: RecordedScan[] = [];
  const pinned = coordinatedFileScan({ exclusive: true, join: false }, recordingRunner(pinnedScans, "pinned"));
  // The fenced catalog caller queues its own shared generation behind the
  // exclusive one instead of receiving the pinned runner's snapshot.
  const fenced = coordinatedFileScan({ join: false }, shared);

  scans[0]!.release();
  await leader;
  await Promise.resolve();
  await Promise.resolve();
  expect(pinnedScans).toHaveLength(1);
  expect(scans).toHaveLength(1);

  pinnedScans[0]!.release();
  expect((await pinned).files.map((file) => file.path)).toEqual(["/sessions/pinned.jsonl"]);
  await Promise.resolve();
  await Promise.resolve();
  expect(scans).toHaveLength(2);
  scans[1]!.release();
  expect((await fenced).files.map((file) => file.path)).toEqual(["/sessions/shared.jsonl"]);
});

test("a failed generation rejects its joiners and the next request scans again", async () => {
  resetFileScanCoordinatorForTests();
  let failures = 0;
  const failing: CoordinatedScanRunner = async () => {
    failures += 1;
    throw new Error("scanner exploded");
  };
  await expect(coordinatedFileScan({}, failing)).rejects.toThrow("scanner exploded");
  expect(failures).toBe(1);

  const scans: RecordedScan[] = [];
  const recovery = coordinatedFileScan({}, recordingRunner(scans));
  await Promise.resolve();
  scans[0]!.release();
  expect((await recovery).complete).toBe(true);
});

test("aborting every subscriber stops the shared refresh and releases its generation", async () => {
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  let refreshes = 0;
  let underlyingAborts = 0;
  const runner: CoordinatedScanRunner = (_intent, signal) => new Promise((_resolve, reject) => {
    refreshes += 1;
    const onAbort = () => {
      underlyingAborts += 1;
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("scan cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const reads = controllers.map((controller) => coordinatedFileScan({ signal: controller.signal }, runner)
    .then(() => "resolved", (error: unknown) => error instanceof Error ? error.name : String(error)));
  await Promise.resolve();
  expect(refreshes).toBe(1);
  expect(fileScanCoordinatorStatus()).toEqual({ inFlight: true, queued: 0, subscribers: 20 });

  for (const controller of controllers) controller.abort();
  expect(await Promise.all(reads)).toEqual(Array.from({ length: 20 }, () => "AbortError"));
  await Promise.resolve();

  expect(underlyingAborts).toBe(1);
  expect(fileScanCoordinatorStatus()).toEqual({ inFlight: false, queued: 0, subscribers: 0 });
});


/* #790: the MCP runtime sidecar runs from the published release root, which
   carries no worker artifact of either kind. Every corpus read it served died
   with `Module not found` on the worker the launcher named anyway, so the
   deployment gate's `board_snapshot` failed on a candidate whose whole HTTP
   surface was healthy. The scan still has to happen - here, in this process. */
test("a process root with no worker artifact scans in-process rather than spawning one it lacks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-scan-release-root-"));
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), "llv-scan-corpus-"));
  const previous = {
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV,
    claudeHome: process.env.LLV_CLAUDE_HOME,
    codexHome: process.env.LLV_CODEX_HOME,
  };
  fs.mkdirSync(path.join(root, "dist"));
  fs.mkdirSync(path.join(corpus, "claude"));
  fs.mkdirSync(path.join(corpus, "codex"));
  try {
    /* NODE_ENV is assigned the way the test preload assigns it: the worker
       boundary is only live outside the test runtime, and this is the branch it
       takes there. */
    Object.assign(process.env, {
      LLV_CLAUDE_HOME: path.join(corpus, "claude"),
      LLV_CODEX_HOME: path.join(corpus, "codex"),
      NODE_ENV: "production",
    });
    process.chdir(root);

    const snapshot = await runFileCatalogScan({ persist: false, fresh: false });

    expect(snapshot.complete).toBe(true);
  } finally {
    process.chdir(previous.cwd);
    for (const [key, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      LLV_CLAUDE_HOME: previous.claudeHome,
      LLV_CODEX_HOME: previous.codexHome,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else Object.assign(process.env, { [key]: value });
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});
