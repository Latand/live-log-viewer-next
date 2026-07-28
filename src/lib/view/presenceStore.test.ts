import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { freshness, listPresence, presenceFile, presenceLimits, resetPresenceForTest, sessionSummary, upsertPresence } from "./presenceStore";
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

/*
 * A phantom desktop is worse than no desktop.
 *
 * The two ways this can be wrong are not symmetric. Reading nothing makes an
 * attention request fail where the operator can see it fail — that is the
 * original defect, and it is loud. Reading a session that is not really there
 * makes the request succeed silently in front of an empty chair: it is recorded
 * as offered, nobody is watching, and nothing ever says so. So the mirror is
 * read with suspicion, and anything it cannot fully vouch for is dropped.
 */

/** Write the mirror directly, the way a foreign process or a damaged write
    would leave it — bypassing `upsertPresence`, which would sanitize it. */
function mirror(sessions: unknown[], now = T0): void {
  fs.writeFileSync(
    presenceFile(),
    JSON.stringify({ schemaVersion: 1, updatedAt: new Date(now).toISOString(), sessions }, null, 2),
    "utf8",
  );
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...payload(), lastSeenAt: T0, lastInteractionAt: T0, ...overrides };
}

test("a session claiming the future is discarded, not believed forever", () => {
  /* `freshness` clamps a negative age at zero, so a future `lastSeenAt` reads
     `active` no matter how long anyone waits, and `expire` — which needs the age
     to EXCEED retention — can never remove it. One such record advertises a
     desktop that does not exist, permanently, and every attention request from
     then on is offered to it. */
  mirror([stored({ viewSessionId: "from-the-future", lastSeenAt: T0 + 3_600_000, lastInteractionAt: T0 + 3_600_000 })]);

  expect(anotherProcess(() => listPresence(T0))).toEqual([]);
  /* Rejected for as long as it is impossible — the whole hour, not just the
     instant it was read. This is the permanence that mattered: unrejected, the
     clamp in `freshness` and the comparison in `expire` between them made the
     entry `active` and unexpirable FOREVER.

     What is deliberately NOT claimed: once the clock reaches its timestamp the
     record is merely old, and it is believed for the ordinary retention window
     like any session that stopped publishing. Refusing it beyond that would
     mean remembering every id ever rejected, which trades a bounded two-minute
     phantom for an unbounded set and a session that a legitimate clock
     correction can never re-admit. */
  expect(anotherProcess(() => listPresence(T0 + 3_000_000))).toEqual([]);
});

test("a small clock disagreement between machines is tolerated", () => {
  /* Two processes sharing a state dir do not share a clock to the millisecond.
     Suspicion is for the impossible, not for the merely early. */
  mirror([stored({ viewSessionId: "slightly-ahead", lastSeenAt: T0 + 1_000, lastInteractionAt: T0 + 1_000 })]);

  expect(anotherProcess(() => listPresence(T0)).map((session) => session.viewSessionId))
    .toEqual(["slightly-ahead"]);
});

test("a partial session is discarded rather than completed with guesses", () => {
  const complete = stored({ viewSessionId: "whole" });
  const cases: Record<string, unknown>[] = [
    { ...stored({ viewSessionId: "no-device" }), deviceId: undefined },
    { ...stored({ viewSessionId: "empty-device" }), deviceId: "" },
    { ...stored({ viewSessionId: "no-input-sequence" }), inputSequence: undefined },
    { ...stored({ viewSessionId: "no-last-seen" }), lastSeenAt: undefined },
    { ...stored({ viewSessionId: "no-interaction" }), lastInteractionAt: undefined },
    { ...stored({ viewSessionId: "no-visibility" }), visibility: undefined },
    { ...stored({ viewSessionId: "bad-visibility" }), visibility: "maybe" },
    { ...stored({ viewSessionId: "" }) },
  ];
  mirror([...cases, complete]);

  /* Only the one entry that answered every question survives. */
  expect(anotherProcess(() => listPresence(T0)).map((session) => session.viewSessionId)).toEqual(["whole"]);
});

test("a malformed timestamp is discarded instead of crashing the read", () => {
  /* A finite number far outside the range `Date` can represent passes a
     `typeof` check, survives the round trip through JSON — unlike `NaN` and
     `Infinity`, which `JSON.stringify` writes as `null` and the shape check
     already refuses — and then reaches `new Date(…).toISOString()`, which
     throws `RangeError: Invalid Date`. That call sits on the read path of
     `request_attention` and `operator_snapshot`, so one damaged record in a
     shared file takes the tool down for every caller on the machine.

     A negative timestamp is the quieter one: `Date` accepts it happily as a
     moment in 1969, so nothing throws and the entry simply lies about a
     desktop that has been stale since before the epoch. */
  mirror([
    stored({ viewSessionId: "out-of-range", lastSeenAt: 1e308 }),
    stored({ viewSessionId: "out-of-range-interaction", lastInteractionAt: 1e308 }),
    stored({ viewSessionId: "string-time", lastSeenAt: "2026-07-01T10:00:00.000Z" }),
    stored({ viewSessionId: "negative", lastSeenAt: -1 }),
    stored({ viewSessionId: "epoch", lastSeenAt: 0 }),
    stored({ viewSessionId: "null-time", lastSeenAt: null }),
  ]);

  /* Summarizing is what `operator_snapshot` and `request_attention` actually do
     with what they read, and it is where the throw lands — so the test has to
     go through it rather than stopping at the id list. */
  let seen: unknown;
  expect(() => {
    seen = anotherProcess(() => listPresence(T0).map((session) => sessionSummary(session, T0).viewSessionId));
  }).not.toThrow();
  expect(seen).toEqual([]);
});

test("a mirror of nothing but junk leaves a real local session standing", () => {
  /* Degrading to "this process knows only what it was told" is the designed
     failure. Dropping the bad entries must not drop the good ones with them. */
  upsertPresence(payload(), T0);
  mirror([stored({ viewSessionId: "future", lastSeenAt: T0 + 3_600_000 }), null, 7, "session", []], T0);

  expect(listPresence(T0 + 1_000).map((session) => session.viewSessionId)).toEqual(["view-1"]);
});

test("a record whose nested shape is incomplete is discarded, however plausible its surface", () => {
  /* The quiet one, and the reason this matters more than its severity: a record
     can be well-formed exactly where the offer path looks and arbitrary
     everywhere else. `followCapableDevices` reads `session.device.kind` and
     nothing more, so such an entry advertises a desktop that does not exist —
     the request is recorded as offered, nobody is watching, and the operator is
     never told. A partial record is untrustworthy, not degraded. */
  const cases: Record<string, unknown>[] = [
    { ...stored({ viewSessionId: "no-device" }), device: undefined },
    { ...stored({ viewSessionId: "device-not-an-object" }), device: "desktop" },
    { ...stored({ viewSessionId: "device-half" }), device: { kind: "desktop" } },
    { ...stored({ viewSessionId: "device-unknown-kind" }), device: { kind: "toaster", browser: "chrome" } },
    { ...stored({ viewSessionId: "device-unknown-browser" }), device: { kind: "desktop", browser: "netscape" } },
    { ...stored({ viewSessionId: "no-viewport" }), viewport: undefined },
    { ...stored({ viewSessionId: "viewport-half" }), viewport: { width: 1_600 } },
    { ...stored({ viewSessionId: "camera-half" }), camera: { x: 1, y: 2, zoom: 3 } },
    { ...stored({ viewSessionId: "camera-world-half" }), camera: { x: 1, y: 2, zoom: 3, worldRect: { x: 0, y: 0 } } },
    { ...stored({ viewSessionId: "no-board" }), board: undefined },
    { ...stored({ viewSessionId: "board-unknown-sync" }), board: { renderedRevision: 1, durableRevision: 1, sync: "vibes" } },
    { ...stored({ viewSessionId: "unknown-mode" }), mode: "hologram" },
    { ...stored({ viewSessionId: "paths-not-strings" }), visiblePaths: [1, 2] },
    { ...stored({ viewSessionId: "wrong-schema" }), schemaVersion: 99 },
  ];
  mirror([...cases, stored({ viewSessionId: "whole" })]);

  expect(anotherProcess(() => listPresence(T0)).map((session) => session.viewSessionId)).toEqual(["whole"]);
});

test("a session with no device never reaches the code that dereferences it", () => {
  /* `followCapableDevices` — inside `request_attention` — reads
     `session.device.kind` with no guard. An entry that got that far without a
     device does not degrade the answer, it throws and takes the tool call down
     for every caller on the machine. */
  mirror([{ ...stored({ viewSessionId: "no-device" }), device: undefined }]);

  const seen = anotherProcess(() => listPresence(T0));
  expect(seen).toEqual([]);
  expect(() => seen.map((session) => session.device.kind)).not.toThrow();
});
