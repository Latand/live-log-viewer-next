import { expect, test } from "bun:test";

import { UNREAD_FRAME_RECT } from "@/lib/attention/frames";
import type { FocusFrameIndex } from "@/lib/attention/resolve";
import type { AttentionRequestV1, FocusFrame, FocusRect } from "@/lib/attention/types";

import { createFocusHandoffBus, type BoardFocusController, type FocusDestination, type ShellNavigator } from "./focusHandoffBus";
import { restoreFocusPoint, runFocusHandoff, usableFrame } from "./navigate";

/*
 * What an accepted request does to the view (#688). Everything here is the part
 * that was missing entirely: the record and its resolution were built and
 * tested, but nothing turned a resolution into a move.
 */

const RECT: FocusRect = { x: 900, y: 1_400, w: 600, h: 780 };

function index(project: string, rects: Record<string, FocusRect>): FocusFrameIndex {
  return {
    project,
    boardRevision: 7,
    rectFor: (key) => rects[key] ?? null,
    named: Object.entries(rects).map(([key, rect]) => ({ key, label: key, rect })),
  };
}

interface Moves {
  moved: FocusDestination[];
  restored: { x: number; y: number; zoom: number }[];
  opened: string[];
  projects: string[];
}

function harness(project: string, rects: Record<string, FocusRect>, shellProject: string | null = project) {
  const bus = createFocusHandoffBus();
  const log: Moves = { moved: [], restored: [], opened: [], projects: [] };
  const board: BoardFocusController = {
    project,
    index: index(project, rects),
    moveTo: (destination) => { log.moved.push(destination); return true; },
    restoreCamera: (camera) => { log.restored.push(camera); return true; },
  };
  const shell: ShellNavigator = {
    project: shellProject,
    openProject: (next) => log.projects.push(next),
    openPath: (path) => log.opened.push(path),
  };
  bus.setBoard(board);
  bus.setShell(shell);
  return { bus, log, board };
}

const frame = (project: string, rect: FocusRect = RECT): FocusFrame => ({ project, rect, boardRevision: 4 });

function request(overrides: Partial<AttentionRequestV1> = {}): Pick<AttentionRequestV1, "target" | "frameAtCreation" | "intent" | "zoom"> {
  return {
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: frame("demo"),
    intent: "show",
    zoom: "situate",
    ...overrides,
  } as Pick<AttentionRequestV1, "target" | "frameAtCreation" | "intent" | "zoom">;
}

const NO_WAIT = { timeoutMs: 0, pollMs: 0 };

test("accepting resolves the anchor against the board as it is now and moves the camera there", async () => {
  const live: FocusRect = { x: 40, y: 60, w: 600, h: 780 };
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": live });

  const outcome = await runFocusHandoff(request(), bus, NO_WAIT);

  expect(outcome.resolution).toBe("exact");
  expect(outcome.moved).toBe(true);
  /* The CURRENT rect, never the one recorded at creation: the board reflows, so
     a stored rect is stale the moment a sibling appears. */
  expect(log.moved).toEqual([{ rect: live, zoom: "situate", anchorKeys: ["/tmp/reviewer.jsonl"] }]);
  expect(log.opened).toEqual([]);
});

test("show frames the target and open also opens it", async () => {
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  await runFocusHandoff(request({ intent: "open", zoom: "inspect" }), bus, NO_WAIT);

  expect(log.moved).toEqual([{ rect: RECT, zoom: "inspect", anchorKeys: ["/tmp/reviewer.jsonl"] }]);
  expect(log.opened).toEqual(["/tmp/reviewer.jsonl"]);
});

test("a vanished anchor degrades to the frame it was raised against, and says so", async () => {
  /* One-way degradation with a destination, rather than a failure: the anchor
     is gone but where it was is still somewhere the operator can be taken. */
  const { bus, log } = harness("demo", { "/tmp/other.jsonl": { x: 0, y: 0, w: 600, h: 780 } });

  const outcome = await runFocusHandoff(request(), bus, NO_WAIT);

  expect(outcome.resolution).toBe("approximate");
  /* No anchor key travels with a degraded landing: there is no object there any
     more, so a surface that can only select objects must refuse it. */
  expect(log.moved).toEqual([{ rect: RECT, zoom: "situate", anchorKeys: [] }]);
});

test("a vanished anchor whose request never read a board reports lost rather than landing at the origin", async () => {
  /* A request raised through the agent's tool records no geometry. Degrading to
     that empty frame would drop the operator at world (0,0) and call it "where
     it was" — the silent arbitrary landing the design refuses. */
  const { bus, log } = harness("demo", {});

  const outcome = await runFocusHandoff(
    request({ frameAtCreation: { project: "demo", rect: UNREAD_FRAME_RECT, boardRevision: null } }),
    bus,
    NO_WAIT,
  );

  expect(outcome.resolution).toBe("lost");
  expect(outcome.moved).toBe(false);
  expect(log.moved).toEqual([]);
  expect(usableFrame({ project: "demo", rect: UNREAD_FRAME_RECT, boardRevision: null })).toBeNull();
});

test("a target in another project opens that project first and waits for its board", async () => {
  const bus = createFocusHandoffBus();
  const log: Moves = { moved: [], restored: [], opened: [], projects: [] };
  bus.setShell({
    project: "demo",
    openProject: (next) => {
      log.projects.push(next);
      /* The board of the newly opened project publishes its layout once it has
         one — the handoff must not resolve against the project it is leaving. */
      bus.setBoard({
        project: next,
        index: index(next, { "task::t1": RECT }),
        moveTo: (destination) => { log.moved.push(destination); return true; },
        restoreCamera: (camera) => { log.restored.push(camera); return true; },
      });
    },
    openPath: (path) => log.opened.push(path),
  });

  const outcome = await runFocusHandoff(
    request({ target: { kind: "task", taskId: "t1" }, frameAtCreation: frame("other") }),
    bus,
    { timeoutMs: 200, pollMs: 1 },
  );

  expect(log.projects).toEqual(["other"]);
  expect(outcome.resolution).toBe("exact");
  expect(log.moved).toEqual([{ rect: RECT, zoom: "situate", anchorKeys: ["task::t1"] }]);
});

test("nothing moves when no board ever answers for the target's project", async () => {
  const bus = createFocusHandoffBus();
  const log: Moves = { moved: [], restored: [], opened: [], projects: [] };
  bus.setShell({ project: "demo", openProject: (next) => log.projects.push(next), openPath: (path) => log.opened.push(path) });

  const outcome = await runFocusHandoff(request({ frameAtCreation: frame("gone") }), bus, { timeoutMs: 5, pollMs: 1 });

  expect(outcome).toEqual({ resolution: "lost", moved: false, frame: null });
});

test("a surface that cannot honour the destination reports lost instead of a false arrival", async () => {
  /* The phone shows one pane at a time and has no camera, so it arrives by
     pinning the anchor. "Where that card used to be" is not somewhere it can
     take anyone — and a card claiming the operator arrived would be worse than
     the honest refusal. */
  const bus = createFocusHandoffBus();
  const refusals: FocusDestination[] = [];
  bus.setBoard({
    project: "demo",
    index: index("demo", { "/tmp/other.jsonl": RECT }),
    moveTo: (destination) => {
      refusals.push(destination);
      return destination.anchorKeys.length > 0;
    },
    restoreCamera: () => false,
  });

  const outcome = await runFocusHandoff(request(), bus, NO_WAIT);

  expect(refusals).toHaveLength(1);
  expect(outcome).toEqual({ resolution: "lost", moved: false, frame: null });
});

test("returning on a camera-less surface falls back to what was focused there", async () => {
  const bus = createFocusHandoffBus();
  const opened: string[] = [];
  bus.setBoard({ project: "demo", index: index("demo", {}), moveTo: () => true, restoreCamera: () => false });
  bus.setShell({ project: "demo", openProject: () => {}, openPath: (path) => opened.push(path) });

  const restored = await restoreFocusPoint(
    { camera: { x: 1, y: 2, zoom: 3 }, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(opened).toEqual(["/tmp/what-i-was-reading.jsonl"]);
});

test("returning restores the exact camera the device left, and does not re-open the node", async () => {
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  const restored = await restoreFocusPoint(
    { camera: { x: 120, y: 340, zoom: 0.55 }, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  /* Opening the focused path would glide the board to that node and undo the
     framing that was just restored, so the captured camera wins outright. */
  expect(log.opened).toEqual([]);
});

test("a camera is never restored into a project it was not captured in", async () => {
  /* A null capture project means this device has no memory of taking the point
     — a reload, or a second tab that shares the device id and renders the same
     return control. Whatever board happens to be registered is not the one
     those world coordinates describe, so restoring into it would land the
     operator at a position that means nothing there. */
  const { bus, log } = harness("some-other-project", { "/tmp/reviewer.jsonl": RECT });

  const restored = await restoreFocusPoint(
    { camera: { x: 120, y: 340, zoom: 0.55 }, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    null,
    bus,
    NO_WAIT,
  );

  expect(log.restored).toEqual([]);
  /* The focused path names a thing rather than a coordinate, so it is the part
     of that viewport that still means the same thing anywhere. */
  expect(restored).toBe(true);
  expect(log.opened).toEqual(["/tmp/what-i-was-reading.jsonl"]);
  expect(log.projects).toEqual([]);
});

test("returning to a camera-less mode restores what was focused there instead", async () => {
  const { bus, log } = harness("demo", {}, "other");

  const restored = await restoreFocusPoint(
    { camera: null, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(log.projects).toEqual(["demo"]);
  expect(log.opened).toEqual(["/tmp/what-i-was-reading.jsonl"]);
});

test("an unmounting board never blanks the controller a fresh one just published", () => {
  const bus = createFocusHandoffBus();
  const first: BoardFocusController = { project: "a", index: index("a", {}), moveTo: () => true, restoreCamera: () => true };
  const second: BoardFocusController = { project: "b", index: index("b", {}), moveTo: () => true, restoreCamera: () => true };

  const releaseFirst = bus.setBoard(first);
  bus.setBoard(second);
  releaseFirst();

  expect(bus.board()).toBe(second);
});
