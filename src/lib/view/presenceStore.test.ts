import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { freshness, listPresence, presenceFile, presenceLimits, resetPresenceForTest, upsertPresence } from "./presenceStore";
import type { PresencePayloadV1 } from "./types";

/*
 * Presence has to answer the same question in every process on the machine.
 *
 * It used to be one in-memory map, and only the Next server ever writes to it —
 * the browser's heartbeat goes to `POST /api/view/presence` and nowhere else.
 * Every other process therefore read an empty map and concluded nobody was
 * looking: the MCP stdio server, which is where the agent's tools run, reported
 * `NO_ACTIVE_VIEW` from `operator_snapshot` and raised attention requests with
 * an empty `offeredTo` while the operator was sitting in front of the board.
 */

let sandbox = "";
let previousStateDir: string | undefined;

const T0 = Date.parse("2026-07-01T10:00:00.000Z");

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-presence-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetPresenceForTest();
});

afterEach(() => {
  resetPresenceForTest();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function payload(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: "device-desktop",
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "demo",
    mode: "scheme",
    viewport: { width: 1_600, height: 900, dpr: 2 },
    camera: { x: 10, y: 20, zoom: 0.6, worldRect: { x: 0, y: 0, width: 100, height: 80 } },
    focusedPath: "/tmp/reviewer.jsonl",
    selectedPaths: [],
    visiblePaths: ["/tmp/reviewer.jsonl"],
    board: { renderedRevision: 4, durableRevision: 4, sync: "current" },
    ...overrides,
  };
}

/** What another process on this machine sees: it was never told anything, so its
    own map is empty and the shared state dir is all it has. */
function anotherProcess<T>(read: () => T): T {
  (globalThis as Record<string, unknown>).__llvViewPresence = new Map();
  return read();
}

test("a view published to the server is visible to every other process on the machine", () => {
  upsertPresence(payload(), T0);

  const seen = anotherProcess(() => listPresence(T0 + 1_000));

  expect(seen.map((session) => session.viewSessionId)).toEqual(["view-1"]);
  expect(seen[0]!.deviceId).toBe("device-desktop");
  expect(seen[0]!.project).toBe("demo");
  expect(freshness(seen[0]!, T0 + 1_000)).toBe("active");
});

test("the mirror lives in the shared state dir, beside the record it is read with", () => {
  upsertPresence(payload(), T0);

  expect(presenceFile()).toBe(path.join(sandbox, "view-presence.json"));
  expect(fs.existsSync(presenceFile())).toBe(true);
});

test("a later heartbeat is what another process sees, and an older one is ignored", () => {
  upsertPresence(payload({ sequence: 1, project: "demo" }), T0);
  upsertPresence(payload({ sequence: 2, project: "other" }), T0 + 5_000);
  /* A retransmitted older beat must not walk the view backwards. */
  expect(upsertPresence(payload({ sequence: 1, project: "demo" }), T0 + 6_000).accepted).toBe(false);

  const seen = anotherProcess(() => listPresence(T0 + 6_000));

  expect(seen).toHaveLength(1);
  expect(seen[0]!.project).toBe("other");
});

test("a view that stopped publishing ages out for every reader, not just the one that held it", () => {
  upsertPresence(payload(), T0);

  const seen = anotherProcess(() => listPresence(T0 + presenceLimits.RETENTION_MS + 1));

  expect(seen).toEqual([]);
});

test("two devices are two entries, newest interaction first", () => {
  upsertPresence(payload({ viewSessionId: "view-1", deviceId: "device-desktop" }), T0);
  upsertPresence(payload({ viewSessionId: "view-2", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }), T0 + 1_000);

  const seen = anotherProcess(() => listPresence(T0 + 2_000));

  expect(seen.map((session) => session.deviceId)).toEqual(["device-phone", "device-desktop"]);
});

test("an unreadable mirror never fails the heartbeat or the read", () => {
  upsertPresence(payload(), T0);
  fs.writeFileSync(presenceFile(), "{ this is not json", "utf8");

  /* The process that owns the heartbeat still knows its own sessions, and a
     publish after the damage repairs the file rather than throwing into the
     route the browser is calling. */
  expect(listPresence(T0 + 1_000)).toHaveLength(1);
  expect(upsertPresence(payload({ sequence: 9 }), T0 + 2_000).accepted).toBe(true);
  expect(anotherProcess(() => listPresence(T0 + 3_000))).toHaveLength(1);
});
