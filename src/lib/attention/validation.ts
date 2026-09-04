import type { AttentionEvent } from "./machine";
import { isFocusTarget } from "./targets";
import type { AttentionCreateInput } from "./store";
import { MAX_JOURNAL_CANDIDATES, type FocusFrame, type ReturnPoint } from "./types";
import type { ViewMode } from "@/lib/view/types";

/**
 * Request-shape validation for #688's HTTP surface. Kept apart from the store's
 * semantic validation: this decides whether a body is a well-formed thing at
 * all, the store decides whether it is an allowable request.
 */

export class AttentionRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "AttentionRequestError";
  }
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readBoundedJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new AttentionRequestError("PAYLOAD_TOO_LARGE", "request body is too large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AttentionRequestError("INVALID_REQUEST", "request body is not JSON");
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttentionRequestError("INVALID_REQUEST", `invalid ${field}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AttentionRequestError("INVALID_REQUEST", `invalid ${field}`);
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AttentionRequestError("INVALID_REQUEST", `invalid ${field}`);
  return value;
}

const VIEW_MODES: readonly ViewMode[] = ["overview", "scheme", "list", "mobile-focus"];

function frame(value: unknown): FocusFrame {
  const raw = object(value, "frameAtCreation");
  const rect = object(raw.rect, "frameAtCreation.rect");
  return {
    project: text(raw.project, "frameAtCreation.project", 256),
    rect: {
      x: finite(rect.x, "frameAtCreation.rect.x"),
      y: finite(rect.y, "frameAtCreation.rect.y"),
      w: finite(rect.w, "frameAtCreation.rect.w"),
      h: finite(rect.h, "frameAtCreation.rect.h"),
    },
    boardRevision: raw.boardRevision === null || raw.boardRevision === undefined
      ? null
      : finite(raw.boardRevision, "frameAtCreation.boardRevision"),
  };
}

function returnPoint(value: unknown): ReturnPoint {
  const raw = object(value, "returnPoint");
  const mode = raw.mode;
  if (typeof mode !== "string" || !VIEW_MODES.includes(mode as ViewMode)) {
    throw new AttentionRequestError("INVALID_REQUEST", "invalid returnPoint.mode");
  }
  const camera = raw.camera === null || raw.camera === undefined ? null : object(raw.camera, "returnPoint.camera");
  return {
    deviceId: text(raw.deviceId, "returnPoint.deviceId", 256),
    mode: mode as ViewMode,
    camera: camera === null ? null : {
      x: finite(camera.x, "returnPoint.camera.x"),
      y: finite(camera.y, "returnPoint.camera.y"),
      zoom: finite(camera.zoom, "returnPoint.camera.zoom"),
    },
    focusedPath: raw.focusedPath === null || raw.focusedPath === undefined ? null : text(raw.focusedPath, "returnPoint.focusedPath"),
    capturedAt: text(raw.capturedAt, "returnPoint.capturedAt", 64),
  };
}

/** The body that raises a request. `rootId` is deliberately absent: the server
    resolves the root identity itself, so nothing can forge one. */
export function validateAttentionCreate(value: unknown): Omit<AttentionCreateInput, "rootId"> {
  const body = object(value, "request");
  const origin = body.origin;
  if (origin !== "root-agent" && origin !== "operator") throw new AttentionRequestError("INVALID_REQUEST", "invalid origin");
  const intent = body.intent;
  if (intent !== "show" && intent !== "open") throw new AttentionRequestError("INVALID_REQUEST", "invalid intent");
  if (!isFocusTarget(body.target)) throw new AttentionRequestError("INVALID_TARGET", "invalid focus target");
  if (body.zoom !== undefined && body.zoom !== "inspect" && body.zoom !== "situate") {
    throw new AttentionRequestError("INVALID_REQUEST", "invalid zoom");
  }
  const candidates = body.candidates === undefined ? undefined : (() => {
    if (!Array.isArray(body.candidates) || body.candidates.length > MAX_JOURNAL_CANDIDATES) {
      throw new AttentionRequestError("INVALID_REQUEST", "invalid candidates");
    }
    return body.candidates.map((entry) => {
      const candidate = object(entry, "candidate");
      return {
        eventId: text(candidate.eventId, "candidate.eventId", 256),
        ...(candidate.kind === undefined ? {} : { kind: text(candidate.kind, "candidate.kind", 64) }),
      };
    });
  })();

  return {
    origin,
    intent,
    target: body.target,
    frameAtCreation: frame(body.frameAtCreation),
    reason: text(body.reason, "reason", 4_096),
    ...(body.zoom === undefined ? {} : { zoom: body.zoom }),
    ...(body.contextLabel === undefined ? {} : { contextLabel: text(body.contextLabel, "contextLabel", 512) }),
    ...(candidates === undefined ? {} : { candidates }),
    ...(body.offeredTo === undefined ? {} : {
      offeredTo: (Array.isArray(body.offeredTo) ? body.offeredTo : []).map((entry) => text(entry, "offeredTo", 256)),
    }),
  };
}

/** The body that answers one. */
export function validateAttentionEvent(value: unknown): AttentionEvent {
  const body = object(value, "event");
  switch (body.kind) {
    case "offer":
    case "preview":
    case "decline":
    case "dismiss":
    /* `abandon` is a device closing ITS OWN agreed request that found nowhere
       to land. It is safe from a client for the same reason `arrive` is: the
       machine accepts it only from `accepted`, and only from the device the
       record names as the acknowledger. */
    case "abandon":
      return { kind: body.kind, deviceId: text(body.deviceId, "deviceId", 256) };
    case "accept": {
      const via = body.via;
      if (via !== undefined && via !== "operator" && via !== "auto-follow") throw new AttentionRequestError("INVALID_REQUEST", "invalid via");
      return { kind: "accept", deviceId: text(body.deviceId, "deviceId", 256), ...(via === undefined ? {} : { via }) };
    }
    case "arrive": {
      const resolution = body.resolution;
      if (resolution !== "exact" && resolution !== "approximate" && resolution !== "lost") {
        throw new AttentionRequestError("INVALID_REQUEST", "invalid resolution");
      }
      return {
        kind: "arrive",
        deviceId: text(body.deviceId, "deviceId", 256),
        returnPoint: returnPoint(body.returnPoint),
        resolution,
      };
    }
    case "return": {
      const via = body.via;
      if (via !== "control" && via !== "manual-move") throw new AttentionRequestError("INVALID_REQUEST", "invalid via");
      return { kind: "return", deviceId: text(body.deviceId, "deviceId", 256), via };
    }
    default:
      /* `expire` and `supersede` are deliberately not reachable from a client:
         the clock and the root agent own them, and a device that could expire
         another device's offer would be a device that can silence the agent. */
      throw new AttentionRequestError("INVALID_REQUEST", "unsupported event");
  }
}
