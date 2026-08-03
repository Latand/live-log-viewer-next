import { expect, test } from "bun:test";

import { UNREAD_FRAME_RECT } from "@/lib/attention/frames";
import type { FocusFrameIndex } from "@/lib/attention/resolve";
import type { AttentionRequestV1, FocusFrame, FocusRect } from "@/lib/attention/types";

import { createFocusHandoffBus, type BoardFocusController, type FocusDestination, type ShellNavigator } from "./focusHandoffBus";
import { restoreFocusPoint, runFocusHandoff, runFocusTransaction, usableFrame, type FocusObservation } from "./navigate";

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
  /** NAVIGATIONS: `openPath` places a card and glides the camera to it. */
  opened: string[];
  /** QUIET OPENS: the card and the history entry, with no camera glide — what
      an `open` handoff records beside its own `moveTo` (#873 review). */
  openedQuiet: string[];
  /** PLACEMENTS: the card enters the layout and the camera does not move. */
  placed: string[];
  /** How many times the shell was sent back to the overview. */
  overview: number;
  projects: string[];
  /** COMBINED cross-project conversation opens: quiet project half + at most
      one recorded focus. `[project, path]` per call. */
  combined: Array<[string | null, string | null]>;
}

function harness(project: string, rects: Record<string, FocusRect>, shellProject: string | null = project) {
  const bus = createFocusHandoffBus();
  const log: Moves = { moved: [], restored: [], opened: [], openedQuiet: [], placed: [], projects: [], overview: 0, combined: [] };
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
    openPathQuiet: (path) => log.openedQuiet.push(path),
    placePath: (path) => { log.placed.push(path); },
    openOverview: () => { log.overview += 1; },
    openConversation: (proj, path) => { log.combined.push([proj, path]); },
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

test("show frames the target and open also opens it — quietly, beside the handoff's own move", async () => {
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  await runFocusHandoff(request({ intent: "open", zoom: "inspect" }), bus, NO_WAIT);

  expect(log.moved).toEqual([{ rect: RECT, zoom: "inspect", anchorKeys: ["/tmp/reviewer.jsonl"] }]);
  /* The QUIET half: card + history entry. The gliding `openPath` would be a
     second camera move racing the `moveTo` above (#873 review, finding 4). */
  expect(log.openedQuiet).toEqual(["/tmp/reviewer.jsonl"]);
  expect(log.opened).toEqual([]);
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
  const log: Moves = { moved: [], restored: [], opened: [], openedQuiet: [], placed: [], projects: [], overview: 0, combined: [] };
  bus.setShell({
    placePath: () => {},
    openOverview: () => {},
    openConversation: () => {},
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
  const log: Moves = { moved: [], restored: [], opened: [], openedQuiet: [], placed: [], projects: [], overview: 0, combined: [] };
  bus.setShell({ project: "demo", openProject: (next) => { log.projects.push(next); }, openPath: (path) => { log.opened.push(path); }, placePath: (path) => { log.placed.push(path); }, openOverview: () => {}, openConversation: () => {} });

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
  bus.setShell({ project: "demo", openProject: () => {}, openPath: (path) => { opened.push(path); }, placePath: () => {}, openOverview: () => {}, openConversation: () => {} });

  const restored = await restoreFocusPoint(
    { mode: "scheme" as const, camera: { x: 1, y: 2, zoom: 3 }, focusedPath: "/tmp/what-i-was-reading.jsonl" },
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
    { mode: "scheme" as const, camera: { x: 120, y: 340, zoom: 0.55 }, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  /* Exactly where the operator was: the same three numbers, once, and nothing
     else touching the camera afterwards. */
  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  expect(log.moved).toEqual([]);
  /* Opening the focused path would glide the board to that node and undo the
     framing that was just restored, so the captured camera wins outright. */
  expect(log.opened).toEqual([]);
  expect(log.placed).toEqual([]);
});

test("Back after a recovered handoff returns to the exact camera the operator left", async () => {
  /* End to end over the fixed path: the request reveals a card that was not on
     the board, lands one move on it, and Back puts the operator back on the
     precise framing they were reading before they agreed — not near it. */
  const rects: Record<string, FocusRect> = {};
  const { bus, log } = harness("demo", rects);
  bus.setShell({
    project: "demo",
    openProject: (next) => log.projects.push(next),
    openPath: (path) => log.opened.push(path),
    placePath: (path) => { log.placed.push(path); rects[path] = { x: 40, y: 60, w: 600, h: 780 }; },
    openOverview: () => {},
    openConversation: () => {},
  });
  const wasReading = { x: 1_204, y: 88, zoom: 0.42 };

  await runFocusHandoff(
    request({ zoom: "inspect", frameAtCreation: { project: "demo", rect: UNREAD_FRAME_RECT, boardRevision: null } }),
    bus,
    NO_WAIT,
  );
  expect(log.moved).toHaveLength(1);

  const restored = await restoreFocusPoint(
    { mode: "scheme" as const, camera: wasReading, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(log.restored).toEqual([wasReading]);
  /* Back restores a framing; it must not frame a thing on the way. */
  expect(log.moved).toHaveLength(1);
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
    { mode: "scheme" as const, camera: { x: 120, y: 340, zoom: 0.55 }, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    null,
    bus,
    NO_WAIT,
  );

  expect(log.restored).toEqual([]);
  /* The focused path names a thing rather than a coordinate, so it is the part
     of that viewport that still means the same thing anywhere. It comes back
     through the combined open (one gesture, one history entry — #866 review),
     with no project half because none was captured. */
  expect(restored).toBe(true);
  expect(log.combined).toEqual([[null, "/tmp/what-i-was-reading.jsonl"]]);
  expect(log.opened).toEqual([]);
  expect(log.projects).toEqual([]);
});

test("returning to a camera-less mode restores what was focused there instead", async () => {
  const { bus, log } = harness("demo", {}, "other");

  const restored = await restoreFocusPoint(
    { mode: "scheme" as const, camera: null, focusedPath: "/tmp/what-i-was-reading.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  /* One combined entry carries both halves of the return (#866 review): the
     project applies quietly and the focus record is the single history entry. */
  expect(log.projects).toEqual([]);
  expect(log.combined).toEqual([["demo", "/tmp/what-i-was-reading.jsonl"]]);
  expect(log.opened).toEqual([]);
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

test("a launched stage reaches a key-navigating surface as the card the board is drawing", async () => {
  /* The phone pins a pane by key; it has no camera and cannot use a rect. A
     launched — or retried — stage is the one anchor whose key and card differ:
     the request names `slot::<pipeline>::<stage>`, and the board dissolved that
     slot into the running agent's conversation card long ago. Handed only the
     slot key, the phone finds nothing on its own list and reports the stage
     lost while it is on screen in front of the operator. */
  const AGENT = "/tmp/retry-attempt.jsonl";
  const bus = createFocusHandoffBus();
  const panes = new Set([AGENT]);
  const destinations: FocusDestination[] = [];
  bus.setBoard({
    project: "demo",
    index: {
      project: "demo",
      boardRevision: 7,
      rectFor: (key) => (key === "slot::p1::review" || key === AGENT ? RECT : null),
      concreteAnchorKey: (key) => (key === "slot::p1::review" ? AGENT : key === AGENT ? AGENT : null),
    },
    moveTo: (destination) => {
      destinations.push(destination);
      /* Exactly what MobileFocusView does: land only on a key it can pin. */
      return destination.anchorKeys.some((key) => panes.has(key));
    },
    restoreCamera: () => false,
  });
  bus.setShell({ project: "demo", openProject: () => {}, openPath: () => {}, placePath: () => {}, openOverview: () => {}, openConversation: () => {} });

  const outcome = await runFocusHandoff({
    target: { kind: "stage", pipelineId: "p1", stageId: "review" },
    frameAtCreation: frame("demo"),
    intent: "show",
    zoom: "situate",
  } as AttentionRequestV1, bus, NO_WAIT);

  expect(outcome.resolution).toBe("exact");
  expect(outcome.moved).toBeTrue();
  /* The concrete card first, because that is what the board is drawing; the
     requested slot key stays behind it for a surface that lists it that way. */
  expect(destinations[0]!.anchorKeys).toEqual([AGENT, "slot::p1::review"]);
});

test("a stage still waiting to launch is pinned by its own slot", async () => {
  /* No alias yet: the placeholder slot IS the card, and the concrete key is the
     requested one. Nothing may be duplicated into the list on this path. */
  const bus = createFocusHandoffBus();
  const destinations: FocusDestination[] = [];
  bus.setBoard({
    project: "demo",
    index: {
      project: "demo",
      boardRevision: 7,
      rectFor: (key) => (key === "slot::p1::deploy" ? RECT : null),
      concreteAnchorKey: (key) => (key === "slot::p1::deploy" ? key : null),
    },
    moveTo: (destination) => { destinations.push(destination); return true; },
    restoreCamera: () => false,
  });
  bus.setShell({ project: "demo", openProject: () => {}, openPath: () => {}, placePath: () => {}, openOverview: () => {}, openConversation: () => {} });

  await runFocusHandoff({
    target: { kind: "stage", pipelineId: "p1", stageId: "deploy" },
    frameAtCreation: frame("demo"),
    intent: "show",
    zoom: "situate",
  } as AttentionRequestV1, bus, NO_WAIT);

  expect(destinations[0]!.anchorKeys).toEqual(["slot::p1::deploy"]);
});

test("a conversation the board is not showing is asked for, and the handoff lands once it arrives", async () => {
  /* The live failure this closes: a worker conversation that has folded away or
     never entered this layout is not in the index, and a request raised through
     the agent's tool carries no frame to fall back on — so the handoff reported
     `lost`, nothing moved, and no way back was ever offered. The shell can place
     that card; it was simply never asked. */
  const rects: Record<string, FocusRect> = {};
  const landed: FocusRect = { x: 320, y: 880, w: 600, h: 780 };
  const { bus, log } = harness("demo", rects);
  bus.setShell({
    project: "demo",
    openProject: (next) => log.projects.push(next),
    openPath: (path) => log.opened.push(path),
    /* What placement does on the real board: the card enters the layout, and
       the camera stays exactly where the operator left it. */
    placePath: (path) => { log.placed.push(path); rects[path] = landed; },
    openOverview: () => {},
    openConversation: () => {},
  });

  const outcome = await runFocusHandoff(
    request({ frameAtCreation: { project: "demo", rect: UNREAD_FRAME_RECT, boardRevision: null } }),
    bus,
    NO_WAIT,
  );

  expect(log.placed).toEqual(["/tmp/reviewer.jsonl"]);
  expect(outcome.resolution).toBe("exact");
  expect(outcome.moved).toBe(true);
  expect(log.moved).toEqual([{ rect: landed, zoom: "situate", anchorKeys: ["/tmp/reviewer.jsonl"] }]);
  /* The recovery reveals; it never navigates. A single production-path move
     stands between the operator and the target. */
  expect(log.opened).toEqual([]);
});

test("recovering a missing card still moves the camera exactly once, at the requested zoom", async () => {
  /* The defect this pins: recovery used `openPath`, which places the card AND
     glides the camera through the production focus pipeline. The handoff then
     issued its own `moveTo` at its own zoom — two competing moves for one
     camera, and the operator watched the view arrive and slide off again.
     Placement carries no camera, so `moveTo` is the whole of the navigation.

     `intent: "open"` is the strictest case: it is the one intent that legitimately
     calls `openPath` afterwards, so if anything is going to move twice it is
     this. The surface opens; the camera does not move again. */
  const rects: Record<string, FocusRect> = {};
  const landed: FocusRect = { x: 0, y: 0, w: 600, h: 780 };
  const { bus, log } = harness("demo", rects);
  bus.setShell({
    project: "demo",
    openProject: (next) => log.projects.push(next),
    /* Modelled as the shell really behaves: `openPath` arms the board's
       pending-focus channel, which flashes the node and GLIDES THE CAMERA. It
       is a move, and counting it is the whole point of this test — a recovery
       routed through here shows up below as a second entry in `log.moved`. */
    openPath: (path) => {
      log.opened.push(path);
      rects[path] ??= landed;
      log.moved.push({ rect: rects[path]!, zoom: "situate", anchorKeys: [path] });
    },
    placePath: (path) => { log.placed.push(path); rects[path] = landed; },
    openOverview: () => {},
    openConversation: () => {},
  });

  const outcome = await runFocusHandoff(
    request({ intent: "open", zoom: "inspect", frameAtCreation: { project: "demo", rect: UNREAD_FRAME_RECT, boardRevision: null } }),
    bus,
    NO_WAIT,
  );

  /* Exactly one move through the production path, and it carries the zoom the
     request asked for rather than whatever the focus pipeline would have used.
     Asserted FIRST: when this regresses, the count is the diagnosis. */
  expect(log.moved).toHaveLength(1);
  expect(log.placed).toEqual(["/tmp/reviewer.jsonl"]);
  expect(log.moved[0]!.zoom).toBe("inspect");
  expect(log.moved[0]!.rect).toEqual(landed);
  /* No navigation edge at all: the card is already placed and framed, so the
     only thing `openPath` could add here is the glide `moveTo` just performed. */
  expect(log.opened).toEqual([]);
  expect(outcome.moved).toBe(true);
});

test("an open intent with the card already on the board opens the surface and still moves once", async () => {
  /* The path that does NOT go through recovery: nothing is missing, so `open`
     records the conversation's open quietly — and the whole gesture is still
     one camera move, not two. */
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  await runFocusHandoff(request({ intent: "open", zoom: "inspect" }), bus, NO_WAIT);

  expect(log.placed).toEqual([]);
  expect(log.openedQuiet).toEqual(["/tmp/reviewer.jsonl"]);
  expect(log.opened).toEqual([]);
  expect(log.moved).toHaveLength(1);
  expect(log.moved[0]!.zoom).toBe("inspect");
});

test("a board that never produces the card still reports lost rather than a false arrival", async () => {
  const { bus, log } = harness("demo", {});

  const outcome = await runFocusHandoff(
    request({ frameAtCreation: { project: "demo", rect: UNREAD_FRAME_RECT, boardRevision: null } }),
    bus,
    NO_WAIT,
  );

  /* Asked for, never delivered: the request is still owed an honest answer. */
  expect(log.placed).toEqual(["/tmp/reviewer.jsonl"]);
  expect(outcome.resolution).toBe("lost");
  expect(log.moved).toEqual([]);
  expect(log.opened).toEqual([]);
});

test("Back from a handoff that began on the overview returns to the overview", async () => {
  /* The inert-Back defect. A request raised while the operator was on the
     overview opens a project to land, so every step of the old restore
     described somewhere INSIDE a project: the project switch, the camera, the
     focused path. None of them can say "no project at all", so pressing Back
     did nothing at all — the control was rendered, the record moved on, and the
     view stayed exactly where the handoff had put it. */
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  const restored = await restoreFocusPoint(
    { mode: "overview", camera: null, focusedPath: null },
    null,
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(log.overview).toBe(1);
  /* Nothing else fires: the overview is the destination, not a stop on the way
     to one, and opening a project or a path here would undo it. */
  expect(log.projects).toEqual([]);
  expect(log.opened).toEqual([]);
  expect(log.moved).toEqual([]);
  expect(log.restored).toEqual([]);
});

test("an overview return point is honoured even when a project and a path were captured with it", async () => {
  /* The mode is what says where they were, and it outranks the rest of the
     record. A capture can carry a stale project or a focused path from before
     the operator stepped out to the overview; restoring either would put them
     back in the project they were being brought out of. */
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  const restored = await restoreFocusPoint(
    { mode: "overview", camera: { x: 5, y: 6, zoom: 0.7 }, focusedPath: "/tmp/reviewer.jsonl" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(log.overview).toBe(1);
  expect(log.projects).toEqual([]);
  expect(log.restored).toEqual([]);
  expect(log.opened).toEqual([]);
});

test("an overview return with no shell to steer reports that it did not restore", async () => {
  /* Honesty at the boundary, the same rule the rest of this module follows: a
     restore that could not happen must not report that it did, or the record
     leaves `following` and the way back disappears with it. */
  const bus = createFocusHandoffBus();

  expect(await restoreFocusPoint({ mode: "overview", camera: null, focusedPath: null }, null, bus, NO_WAIT))
    .toBe(false);
});

test("a cross-project OPEN handoff is one gesture: quiet project half plus exactly one recorded focus", async () => {
  /* The review's medium bar for #866: openProject + openPath stacked TWO
     history entries for a single accepted handoff. The project half must apply
     without recording; the quiet open writes the one entry — and never a
     second glide against the handoff's own move (#873 review, finding 4). */
  const { bus, log } = harness("other", { "/tmp/reviewer.jsonl": RECT }, "demo");

  await runFocusHandoff(request({ intent: "open", frameAtCreation: frame("other") }), bus, NO_WAIT);

  expect(log.projects).toEqual([]);
  expect(log.combined).toEqual([["other", null]]);
  expect(log.openedQuiet).toEqual(["/tmp/reviewer.jsonl"]);
  expect(log.opened).toEqual([]);
});

test("a cross-project SHOW handoff stays a lone project switch and records it as before", async () => {
  const { bus, log } = harness("other", { "/tmp/reviewer.jsonl": RECT }, "demo");

  await runFocusHandoff(request({ intent: "show", frameAtCreation: frame("other") }), bus, NO_WAIT);

  expect(log.projects).toEqual(["other"]);
  expect(log.combined).toEqual([]);
  expect(log.opened).toEqual([]);
});

test("a cross-project return to a focused card (voice/PiP return) records one combined entry", async () => {
  const { bus, log } = harness("other", {}, "demo");

  const restored = await restoreFocusPoint({ camera: null, focusedPath: "/tmp/root.jsonl", mode: "scheme" }, "other", bus, NO_WAIT);

  expect(restored).toBe(true);
  expect(log.projects).toEqual([]);
  expect(log.combined).toEqual([["other", "/tmp/root.jsonl"]]);
  expect(log.opened).toEqual([]);
});

test("a same-project return to a focused card records the focus without a project half", async () => {
  const { bus, log } = harness("demo", {});

  await restoreFocusPoint({ camera: null, focusedPath: "/tmp/root.jsonl", mode: "scheme" }, "demo", bus, NO_WAIT);

  expect(log.projects).toEqual([]);
  expect(log.combined).toEqual([[null, "/tmp/root.jsonl"]]);
});

test("a camera-only return stays a lone project switch", async () => {
  const { bus, log } = harness("other", {}, "demo");

  await restoreFocusPoint({ camera: { x: 5, y: 6, zoom: 1 }, focusedPath: null, mode: "scheme" }, "other", bus, NO_WAIT);

  expect(log.projects).toEqual(["other"]);
  expect(log.combined).toEqual([]);
  expect(log.restored).toEqual([{ x: 5, y: 6, zoom: 1 }]);
});

/* ── #873 review, finding 4: the abortable transaction and the OBSERVED
      arrival ─────────────────────────────────────────────────────────────── */

/** A world rect that shows the frame's center. */
const AT_FRAME = { x: RECT.x - 50, y: RECT.y - 50, width: RECT.w + 100, height: RECT.h + 100 };
/** A world rect somewhere else entirely. */
const ELSEWHERE = { x: 0, y: 0, width: 100, height: 80 };

const cameraIn = (world: { x: number; y: number; width: number; height: number }): FocusObservation["camera"] =>
  ({ x: world.x, y: world.y, zoom: 1, worldRect: world });

test("the arrival waits for the OBSERVED camera to reach the frame: a delayed glide is awaited, not assumed", async () => {
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });
  let reads = 0;
  const observe = (): FocusObservation => {
    reads += 1;
    /* The glide takes three readings to land — the settle wait has to ride it
       out rather than reporting the arrival off `moveTo`'s return value. */
    return { camera: cameraIn(reads < 3 ? ELSEWHERE : AT_FRAME), focusedPath: null };
  };

  const outcome = await runFocusTransaction(request(), bus, { pollMs: 0, timeoutMs: 60_000, sleep: async () => {}, observe });

  expect(outcome.moved).toBe(true);
  expect(outcome.resolution).toBe("exact");
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(log.moved).toHaveLength(1);
});

test("an aborted transaction reports aborted and hands the caller nothing to post", async () => {
  const { bus } = harness("demo", { "/tmp/reviewer.jsonl": RECT });
  const controller = new AbortController();
  const observe = (): FocusObservation => {
    /* The tab is going away mid-glide — the exact case that used to record an
       arrival for a camera nobody was watching land. */
    controller.abort();
    return { camera: cameraIn(ELSEWHERE), focusedPath: null };
  };

  const outcome = await runFocusTransaction(request(), bus, { pollMs: 0, timeoutMs: 60_000, sleep: async () => {}, signal: controller.signal, observe });

  expect(outcome.aborted).toBe(true);
});

test("a transaction aborted BEFORE anything moved leaves the board untouched", async () => {
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });
  const controller = new AbortController();
  controller.abort();

  const outcome = await runFocusTransaction(request(), bus, { ...NO_WAIT, signal: controller.signal, observe: () => ({ camera: null, focusedPath: null }) });

  expect(outcome.aborted).toBe(true);
  expect(log.moved).toEqual([]);
});

test("a glide that never shows the frame inside the deadline closes as lost, not as a false follow", async () => {
  const { bus } = harness("demo", { "/tmp/reviewer.jsonl": RECT });
  let clock = 0;
  const outcome = await runFocusTransaction(request(), bus, {
    pollMs: 1,
    timeoutMs: 200,
    sleep: async () => { clock += 100; },
    now: () => clock,
    observe: () => ({ camera: cameraIn(ELSEWHERE), focusedPath: null }),
  });

  expect(outcome.resolution).toBe("lost");
  expect(outcome.moved).toBe(false);
});

test("an OPEN whose surface reports the target focused settles on that observation", async () => {
  const { bus } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  const outcome = await runFocusTransaction(request({ intent: "open" }), bus, {
    pollMs: 0,
    timeoutMs: 60_000,
    sleep: async () => {},
    observe: () => ({ camera: cameraIn(ELSEWHERE), focusedPath: "/tmp/reviewer.jsonl" }),
  });

  expect(outcome.moved).toBe(true);
  expect(outcome.resolution).toBe("exact");
});

test("a RESUMED transaction whose view already shows the frame re-issues nothing", async () => {
  /* The remount-mid-handoff recovery: the first mount moved the camera and
     died before reporting. The resume owes the record an arrival, and the
     operator zero additional movement. */
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });

  const outcome = await runFocusTransaction(request(), bus, {
    ...NO_WAIT,
    resume: true,
    observe: () => ({ camera: cameraIn(AT_FRAME), focusedPath: null }),
  });

  expect(outcome.moved).toBe(true);
  expect(outcome.resolution).toBe("exact");
  expect(log.moved).toEqual([]);
});

test("a RESUMED transaction whose camera never arrived runs the move it still owes", async () => {
  const { bus, log } = harness("demo", { "/tmp/reviewer.jsonl": RECT });
  let landed = false;
  const observe = (): FocusObservation => ({ camera: cameraIn(landed ? AT_FRAME : ELSEWHERE), focusedPath: null });
  bus.setBoard({
    project: "demo",
    index: index("demo", { "/tmp/reviewer.jsonl": RECT }),
    moveTo: (destination) => { log.moved.push(destination); landed = true; return true; },
    restoreCamera: () => true,
  });

  const outcome = await runFocusTransaction(request(), bus, { pollMs: 0, timeoutMs: 60_000, sleep: async () => {}, resume: true, observe });

  expect(outcome.moved).toBe(true);
  expect(log.moved).toHaveLength(1);
});

/* ── #873 review, finding 5: Return restores the WHOLE viewport quietly ──── */

test("Return restores camera AND focused card together, quietly: one visible move, one history entry", async () => {
  const { bus, log } = harness("demo", {});

  const restored = await restoreFocusPoint(
    { camera: { x: 120, y: 340, zoom: 0.55 }, focusedPath: "/tmp/what-i-was-reading.jsonl", mode: "scheme" },
    "demo",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  expect(log.restored).toEqual([{ x: 120, y: 340, zoom: 0.55 }]);
  /* The focused card comes back beside the camera — through the QUIET open,
     because the gliding one would undo the exact framing just restored. */
  expect(log.openedQuiet).toEqual(["/tmp/what-i-was-reading.jsonl"]);
  expect(log.opened).toEqual([]);
});

test("a cross-project Return with camera and card applies the project quietly: no stacked history entries", async () => {
  const { bus, log } = harness("other", {}, "demo");

  const restored = await restoreFocusPoint(
    { camera: { x: 5, y: 6, zoom: 1 }, focusedPath: "/tmp/what-i-was-reading.jsonl", mode: "scheme" },
    "other",
    bus,
    NO_WAIT,
  );

  expect(restored).toBe(true);
  /* Quiet project half — never `openProject`, which records its own entry. */
  expect(log.projects).toEqual([]);
  expect(log.combined).toEqual([["other", null]]);
  expect(log.restored).toEqual([{ x: 5, y: 6, zoom: 1 }]);
  expect(log.openedQuiet).toEqual(["/tmp/what-i-was-reading.jsonl"]);
});
