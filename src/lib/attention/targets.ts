import type { FocusIntent, FocusRect, FocusTarget, GeometricFocusTarget, ZoomIntent } from "./types";

/**
 * The typed target model (#688 D7) and the board keys each target resolves
 * through.
 *
 * None of these keys are invented here: the scheme layout already addresses
 * every one of them — transcript paths for conversations, `task::<id>`,
 * `draft::<id>`, `deck::<flowId>`, `slot::<pipelineId>::<stageId>` and
 * `group::pipeline::<id>`. The typed target is a naming of what the layout can
 * already resolve, which is why no new camera capability is needed for any of
 * them.
 */

/** Side of the nominal box a bare point frames as. Mirrors the board's node
    width, so "take me to that spot" lands with a card's worth of context rather
    than a degenerate rect the camera cannot fit. */
export const POINT_FRAME_SIZE = 600;

export function isGeometricTarget(target: FocusTarget): target is GeometricFocusTarget {
  return target.kind === "region" || target.kind === "point";
}

/** The project a target names by itself. Object anchors do not carry one — they
    are found in whichever project's layout holds them. */
export function focusTargetProject(target: FocusTarget): string | null {
  return isGeometricTarget(target) ? target.project : null;
}

/**
 * Board keys to look the anchor up under, in preference order.
 *
 * A stage is the one target with two possible surfaces: before it materializes
 * it is a placeholder slot, and afterwards it is the live conversation of the
 * agent running it. Both register under the slot key in the frame index, so the
 * request does not have to know which one exists yet.
 */
export function focusTargetAnchorKeys(target: FocusTarget): string[] {
  switch (target.kind) {
    case "conversation":
      return [target.path];
    case "pipeline":
      return [`group::pipeline::${target.pipelineId}`];
    case "stage":
      return [`slot::${target.pipelineId}::${target.stageId}`];
    case "flowRound":
      return [`deck::${target.flowId}`];
    case "task":
      return [`task::${target.taskId}`];
    case "draft":
      return [`draft::${target.draftId}`];
    case "region":
    case "point":
      /* Geometric targets have no anchor by construction. That is not a gap:
         a coordinate is a destination, and the anchor/frame split exists
         precisely so a destination can outlive any anchor. */
      return [];
  }
}

/** The frame a geometric target denotes, with no layout lookup at all. */
export function geometricFrameRect(target: GeometricFocusTarget): FocusRect {
  if (target.kind === "region") return target.rect;
  return {
    x: target.x - POINT_FRAME_SIZE / 2,
    y: target.y - POINT_FRAME_SIZE / 2,
    w: POINT_FRAME_SIZE,
    h: POINT_FRAME_SIZE,
  };
}

/**
 * Zoom follows intent, not type (D8): `open` means the operator is about to read
 * something, so zoom in until it is readable; `show` means they are getting
 * their bearings, so fit the frame with context around it. The same field that
 * decides whether anything opens decides this, which is why they are one field
 * rather than two.
 *
 * A request may still state a zoom explicitly; this is only the default.
 */
export function defaultZoomIntent(_target: FocusTarget, intent: FocusIntent): ZoomIntent {
  return intent === "open" ? "inspect" : "situate";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRect(value: unknown): value is FocusRect {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rect = value as Partial<FocusRect>;
  return finite(rect.x) && finite(rect.y) && finite(rect.w) && finite(rect.h) && rect.w! >= 0 && rect.h! >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

export function isFocusTarget(value: unknown): value is FocusTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as { kind?: unknown } & Record<string, unknown>;
  switch (target.kind) {
    case "conversation":
      return nonEmpty(target.path);
    case "pipeline":
      return nonEmpty(target.pipelineId);
    case "stage":
      return nonEmpty(target.pipelineId) && nonEmpty(target.stageId);
    case "flowRound":
      return nonEmpty(target.flowId) && Number.isInteger(target.round) && (target.round as number) >= 0;
    case "task":
      return nonEmpty(target.taskId);
    case "draft":
      return nonEmpty(target.draftId);
    case "region":
      return nonEmpty(target.project) && isRect(target.rect);
    case "point":
      return nonEmpty(target.project) && finite(target.x) && finite(target.y)
        && (target.zoom === undefined || (finite(target.zoom) && (target.zoom as number) > 0));
    default:
      return false;
  }
}

/**
 * Whether a target may be opened rather than only shown.
 *
 * There is nothing to open at a coordinate, so a geometric target accepts
 * `show` only — and a request that says otherwise is refused at creation with a
 * clear error rather than silently downgraded, because a silent downgrade would
 * make the spoken confirmation a lie about what is going to happen.
 */
export function targetAcceptsIntent(target: FocusTarget, intent: FocusIntent): boolean {
  return intent === "show" || !isGeometricTarget(target);
}
