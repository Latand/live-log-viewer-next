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

/**
 * The per-kind input contract, PUBLISHED rather than discovered (#1016).
 *
 * `FocusTarget` is a discriminated union, and until this table existed the
 * discriminator lived only in the type: the MCP schema declared a free-form
 * object and every rejection said "target must be a typed focus target", so a
 * caller could only guess at `kind` and its fields. Five reasonable guesses in
 * a row lost, and the handoff was abandoned mid-deploy.
 *
 * One table, read by both surfaces that have to speak this contract — the tool
 * definition the caller reads BEFORE calling, and the error it reads after —
 * so the published shape and the refused shape can never drift apart.
 */
export interface FocusTargetShape {
  kind: FocusTarget["kind"];
  /** The fields this kind needs, spelled exactly as a caller must send them. */
  fields: string;
  /** A call that works, verbatim. */
  example: string;
}

export const FOCUS_TARGET_SHAPES: readonly FocusTargetShape[] = [
  {
    kind: "conversation",
    /* Both forms, because the durable id is what the rest of the MCP surface
       speaks and the path is what the record stores (#1016). */
    fields: 'conversationId (the durable "conversation_…" id, resolved to its current transcript) or path (that transcript\'s .jsonl path) — at least one',
    example: '{"kind":"conversation","conversationId":"conversation_9f2c"}',
  },
  {
    kind: "pipeline",
    fields: "pipelineId (non-empty string)",
    example: '{"kind":"pipeline","pipelineId":"pipeline_9f2c"}',
  },
  {
    kind: "stage",
    fields: "pipelineId and stageId (non-empty strings)",
    example: '{"kind":"stage","pipelineId":"pipeline_9f2c","stageId":"review"}',
  },
  {
    kind: "flowRound",
    fields: "flowId (non-empty string) and round (integer, 0 or more)",
    example: '{"kind":"flowRound","flowId":"flow_9f2c","round":2}',
  },
  {
    kind: "task",
    fields: "taskId (non-empty string)",
    example: '{"kind":"task","taskId":"task_9f2c"}',
  },
  {
    kind: "draft",
    fields: "draftId (non-empty string), and a top-level project alongside target — a draft exists only on the operator's canvas, so the server cannot attribute it",
    example: '{"kind":"draft","draftId":"draft_9f2c"}',
  },
  {
    kind: "region",
    fields: "project (non-empty string) and rect {x, y, w, h} (finite numbers; w and h 0 or more)",
    example: '{"kind":"region","project":"live-log-viewer-next","rect":{"x":0,"y":0,"w":800,"h":600}}',
  },
  {
    kind: "point",
    fields: "project (non-empty string), x and y (finite numbers), and an optional zoom (greater than 0)",
    example: '{"kind":"point","project":"live-log-viewer-next","x":1200,"y":480}',
  },
];

export const FOCUS_TARGET_KINDS: readonly FocusTarget["kind"][] = FOCUS_TARGET_SHAPES.map((shape) => shape.kind);

/** The second accepted conversation form, for the errors that have to name both
    of them: an id that resolves to nothing is indistinguishable, to the caller,
    from an id form that was never supported. */
export const CONVERSATION_PATH_EXAMPLE = '{"kind":"conversation","path":"/…/transcript.jsonl"}';

function shapeFor(kind: unknown): FocusTargetShape | undefined {
  return FOCUS_TARGET_SHAPES.find((shape) => shape.kind === kind);
}

/** One call that works, for the kind asked about. */
export function focusTargetExample(kind: FocusTarget["kind"]): string {
  return shapeFor(kind)!.example;
}

/** Keys only, never values: the message is read by whoever mis-shaped the call,
    and a target's contents are the operator's, not the error's. */
function receivedKeys(value: object): string {
  const keys = Object.keys(value).slice(0, 10);
  return keys.length > 0 ? ` (received keys: ${keys.join(", ")})` : " (received no keys)";
}

/**
 * Why a value is not a focus target, in words that name the way through: the
 * discriminator, the fields the ATTEMPTED kind expects, and one example that
 * works. Nothing here judges intent — a caller that guessed `type` instead of
 * `kind` reads the same sentence as one that guessed nothing.
 */
export function describeFocusTargetRejection(value: unknown): string {
  const kinds = FOCUS_TARGET_KINDS.join(" | ");
  const conversation = focusTargetExample("conversation");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `target must be an object discriminated by "kind": one of ${kinds} — e.g. ${conversation}`;
  }
  const kind = (value as { kind?: unknown }).kind;
  const shape = shapeFor(kind);
  if (!shape) {
    const read = typeof kind === "string" && kind.length > 0 ? `read kind "${kind}"` : 'read no "kind"';
    return `target.kind must be one of ${kinds}; ${read}${receivedKeys(value)} — e.g. ${conversation}`;
  }
  return `target kind "${shape.kind}" expects ${shape.fields}${receivedKeys(value)} — e.g. ${shape.example}`;
}
