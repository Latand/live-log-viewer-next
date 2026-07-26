import { frameWasRead } from "@/lib/attention/frames";
import { navigableAnchorKeys, resolveFocusTarget, type FocusFrameIndex } from "@/lib/attention/resolve";
import { focusTargetAnchorKeys, isGeometricTarget } from "@/lib/attention/targets";
import type { FocusTarget } from "@/lib/attention/types";
import type { AttentionRequestV1, FocusFrame, FocusResolutionKind, ReturnPoint } from "@/lib/attention/types";

import type { FocusHandoffBus } from "./focusHandoffBus";

/**
 * What an accepted request actually does to the view (#688 D7/D8).
 *
 * The whole move is one function of a request and a bus, so the part that is
 * easy to get wrong — which project, which frame, and what happens when the
 * anchor is gone — is testable without a renderer or a camera.
 *
 * Two rules from the design are enforced here rather than left to the caller:
 *
 * - the anchor is resolved against the CURRENT layout, never the stored rect,
 *   because the board reflows and a rect recorded at creation is stale as soon
 *   as a sibling appears. The stored frame is the destination only when the
 *   anchor itself has vanished;
 * - a frame that was never really read is not a destination. A request raised
 *   through the agent's tool has no board geometry to record, so it carries a
 *   zero-area frame; degrading to it would drop the operator at the world
 *   origin, which is precisely the "somewhere arbitrary" the design forbids.
 *   Such a frame is discarded, and the resolution reports `lost` instead.
 */

/** How long a handoff waits for another project's board to publish its layout
    after the shell was asked to open it. */
export const BOARD_WAIT_MS = 4_000;
const BOARD_POLL_MS = 40;

/** Zoom the camera reaches for when the operator is about to READ the target. */
export const INSPECT_ZOOM = 0.9;

export interface FocusHandoffResult {
  resolution: FocusResolutionKind;
  /** Whether the view was actually asked to move. False for `lost`. */
  moved: boolean;
  frame: FocusFrame | null;
}

export interface HandoffTiming {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The project a request lands in. A geometric target names its own; every
    object anchor is found in whichever project's layout holds it, so the frame
    recorded at creation is what says where to look. */
export function focusHandoffProject(request: Pick<AttentionRequestV1, "target" | "frameAtCreation">): string {
  return isGeometricTarget(request.target) ? request.target.project : request.frameAtCreation.project;
}

/**
 * The stored frame, but only when it is a real reading of a board.
 *
 * See the module note: a degenerate rect is the signature of a request raised
 * without a board in front of it, and standing in for a vanished anchor with it
 * would land the operator nowhere in particular.
 */
export function usableFrame(frame: FocusFrame | null | undefined): FocusFrame | null {
  return frameWasRead(frame) ? frame! : null;
}

/**
 * The anchor's keys that the board actually holds, in preference order. Empty
 * when the landing has no object behind it at all.
 *
 * Resolved through the index rather than filtered by it, so an aliased anchor
 * arrives as the key the board is DRAWING and not only as the one the request
 * asked for. A launched or retried pipeline stage is exactly that case: the
 * request names its slot, the board has long since replaced that slot with the
 * running agent's card, and a phone handed only the slot key concludes the
 * stage is gone while it is on screen in front of the operator.
 */
function presentAnchorKeys(target: FocusTarget | null, index: FocusFrameIndex): string[] {
  if (!target || isGeometricTarget(target)) return [];
  return navigableAnchorKeys(index, focusTargetAnchorKeys(target));
}

async function boardForProject(bus: FocusHandoffBus, project: string, timing: HandoffTiming) {
  const timeoutMs = timing.timeoutMs ?? BOARD_WAIT_MS;
  const pollMs = timing.pollMs ?? BOARD_POLL_MS;
  const sleep = timing.sleep ?? wait;
  const now = timing.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  for (;;) {
    const board = bus.board();
    if (board?.project === project) return board;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/**
 * Move the operator's view to an accepted request's target.
 *
 * The caller has already captured where they were leaving from — that has to
 * happen before this runs, because opening another project moves the view on
 * its own.
 */
export async function runFocusHandoff(
  request: Pick<AttentionRequestV1, "target" | "frameAtCreation" | "intent" | "zoom">,
  bus: FocusHandoffBus,
  timing: HandoffTiming = {},
): Promise<FocusHandoffResult> {
  const project = focusHandoffProject(request);
  const shell = bus.shell();
  if (shell && shell.project !== project) shell.openProject(project);

  const board = await boardForProject(bus, project, timing);
  const resolved = resolveFocusTarget(request.target, usableFrame(request.frameAtCreation), board?.index ?? null);
  if (!board || !resolved.frame || resolved.resolution === "lost") {
    /* Nowhere to land. Nothing moves, and the caller reports `lost` to the
       record rather than pretending the operator arrived somewhere. */
    return { resolution: "lost", moved: false, frame: null };
  }

  const moved = board.moveTo({
    rect: resolved.frame.rect,
    zoom: request.zoom,
    anchorKeys: presentAnchorKeys(resolved.degraded ? null : resolved.target, board.index),
  });
  /* A surface that cannot go there has not gone there. The phone shows one pane
     at a time and has no camera, so "where that card used to be" is not
     somewhere it can take anyone — and saying so is better than a card that
     claims the operator arrived. */
  if (!moved) return { resolution: "lost", moved: false, frame: null };
  /* `open` also opens the target's own surface; `show` frames it and stops
     there. Only a conversation has a surface to open — a geometric target is
     refused the intent at creation, and the rest are board objects the frame
     itself puts on screen. */
  if (request.intent === "open" && request.target.kind === "conversation") shell?.openPath(request.target.path);
  return { resolution: resolved.resolution, moved: true, frame: resolved.frame };
}

/**
 * Put the view back where the operator was before they agreed.
 *
 * A captured camera is the authoritative framing and wins outright: re-opening
 * the focused path would glide the board to that node and undo the restore. In
 * the modes presence forbids a camera in, the focused path IS what they were
 * looking at, so that is what comes back.
 *
 * A camera is world coordinates in ONE project's layout, so it is only ever
 * restored into the project it was captured in. `project` is null when this
 * device has no memory of capturing the point — after a reload, or in a second
 * tab that shares the device id and therefore renders the same return control.
 * Restoring into whichever board happens to be registered would put the
 * operator at a position that means nothing there, so the camera is skipped and
 * the focused path — which names a thing rather than a coordinate — is what
 * comes back instead.
 */
export async function restoreFocusPoint(
  point: Pick<ReturnPoint, "camera" | "focusedPath">,
  project: string | null,
  bus: FocusHandoffBus,
  timing: HandoffTiming = {},
): Promise<boolean> {
  const shell = bus.shell();
  if (project && shell && shell.project !== project) shell.openProject(project);

  if (point.camera && project) {
    const board = await boardForProject(bus, project, timing);
    if (board?.restoreCamera(point.camera)) return true;
    /* A surface with no camera falls through to what was focused there, which
       is the only part of that viewport it can put back. */
  }
  if (point.focusedPath && shell) {
    shell.openPath(point.focusedPath);
    return true;
  }
  /* Nothing was captured worth restoring — an overview with no focused card is
     already where they were, and the project switch above is the whole move. */
  return Boolean(project && shell);
}
