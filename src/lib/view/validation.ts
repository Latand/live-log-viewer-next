import { MAX_PRESENCE_BYTES, MAX_SCOPE_PATHS, MAX_SELECTED_PATHS, MAX_VISIBLE_PATHS, type PresencePayloadV1, type SnapshotRequestV1 } from "./types";

export class ViewValidationError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "UNSUPPORTED_SCHEMA_VERSION" | "SCOPE_TOO_LARGE" | "PAYLOAD_TOO_LARGE", message: string, readonly status = 400) { super(message); }
}

function record(value: unknown, field = "request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ViewValidationError("INVALID_REQUEST", `unknown ${field}.${unknown}`);
}
function string(value: unknown, field: string, options: { nullable?: boolean; max?: number } = {}): string | null {
  if (options.nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > (options.max ?? 4096)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value;
}
function finite(value: unknown, field: string, min = -1_000_000_000, max = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value;
}
function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = finite(value, field, min, max);
  if (!Number.isInteger(parsed)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return parsed;
}
function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value as T;
}
function paths(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new ViewValidationError(field === "scope.paths" ? "SCOPE_TOO_LARGE" : "INVALID_REQUEST", `invalid ${field}`, field === "scope.paths" ? 413 : 400);
  const parsed = value.map((item) => string(item, field)!);
  if (new Set(parsed).size !== parsed.length) throw new ViewValidationError("INVALID_REQUEST", `duplicate ${field}`);
  return parsed;
}
function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined { return value === undefined ? undefined : record(value, field); }

export function validatePresence(value: unknown): PresencePayloadV1 {
  const body = record(value);
  exact(body, ["schemaVersion", "viewSessionId", "deviceId", "device", "visibility", "sequence", "inputSequence", "project", "mode", "viewport", "camera", "focusedPath", "selectedPaths", "visiblePaths", "board"], "request");
  if (body.schemaVersion !== 1) throw new ViewValidationError("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be 1");
  const device = record(body.device, "device"); exact(device, ["kind", "browser"], "device");
  const viewport = record(body.viewport, "viewport"); exact(viewport, ["width", "height", "dpr"], "viewport");
  const board = record(body.board, "board"); exact(board, ["renderedRevision", "durableRevision", "sync"], "board");
  const mode = oneOf(body.mode, "mode", ["overview", "scheme", "list", "mobile-focus", "mobile-map"] as const);
  const camera = body.camera === null ? null : record(body.camera, "camera");
  if (camera) exact(camera, ["x", "y", "zoom", "worldRect"], "camera");
  const worldRect = camera ? record(camera.worldRect, "camera.worldRect") : null;
  if (worldRect) exact(worldRect, ["x", "y", "width", "height"], "camera.worldRect");
  if ((mode === "overview" || mode === "list" || mode === "mobile-focus") && camera !== null) throw new ViewValidationError("INVALID_REQUEST", `camera must be null in ${mode}`);
  return {
    schemaVersion: 1,
    viewSessionId: string(body.viewSessionId, "viewSessionId")!, deviceId: string(body.deviceId, "deviceId")!,
    device: { kind: oneOf(device.kind, "device.kind", ["desktop", "tablet", "mobile"] as const), browser: oneOf(device.browser, "device.browser", ["chrome", "firefox", "safari", "other"] as const) },
    visibility: oneOf(body.visibility, "visibility", ["visible", "hidden"] as const), sequence: integer(body.sequence, "sequence"), inputSequence: integer(body.inputSequence, "inputSequence"),
    project: string(body.project, "project", { nullable: true, max: 256 }), mode,
    viewport: { width: finite(viewport.width, "viewport.width", 1, 100_000), height: finite(viewport.height, "viewport.height", 1, 100_000), dpr: finite(viewport.dpr, "viewport.dpr", 0.1, 100) },
    camera: camera ? { x: finite(camera.x, "camera.x"), y: finite(camera.y, "camera.y"), zoom: finite(camera.zoom, "camera.zoom", 0.0001, 1000), worldRect: { x: finite(worldRect!.x, "camera.worldRect.x"), y: finite(worldRect!.y, "camera.worldRect.y"), width: finite(worldRect!.width, "camera.worldRect.width", 0, 1_000_000_000), height: finite(worldRect!.height, "camera.worldRect.height", 0, 1_000_000_000) } } : null,
    focusedPath: string(body.focusedPath, "focusedPath", { nullable: true }), selectedPaths: paths(body.selectedPaths, "selectedPaths", MAX_SELECTED_PATHS), visiblePaths: paths(body.visiblePaths, "visiblePaths", MAX_VISIBLE_PATHS),
    board: { renderedRevision: board.renderedRevision === null ? null : integer(board.renderedRevision, "board.renderedRevision"), durableRevision: board.durableRevision === null ? null : integer(board.durableRevision, "board.durableRevision"), sync: oneOf(board.sync, "board.sync", ["current", "pending", "stale", "unavailable"] as const) },
  };
}

export function validateSnapshotRequest(value: unknown): SnapshotRequestV1 {
  const body = record(value); exact(body, ["schemaVersion", "view", "scope", "text", "caller"], "request");
  if (body.schemaVersion !== 1) throw new ViewValidationError("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be 1");
  const view = optionalRecord(body.view, "view"); if (view) exact(view, ["id", "deviceId", "resolution"], "view");
  const scope = optionalRecord(body.scope, "scope"); if (scope) exact(scope, ["kind", "paths"], "scope");
  const textOptions = optionalRecord(body.text, "text"); if (textOptions) exact(textOptions, ["include", "lastMessages", "maxCharsPerConversation"], "text");
  const caller = optionalRecord(body.caller, "caller"); if (caller) exact(caller, ["pid", "transcriptPath"], "caller");
  const kind = scope ? oneOf(scope.kind, "scope.kind", ["focused", "selected", "visible", "focused-selected", "paths"] as const) : undefined;
  const scopePaths = scope?.paths === undefined ? undefined : paths(scope.paths, "scope.paths", MAX_SCOPE_PATHS);
  if (kind === "paths" && !scopePaths) throw new ViewValidationError("INVALID_REQUEST", "scope.paths is required");
  if (kind !== "paths" && scopePaths) throw new ViewValidationError("INVALID_REQUEST", "scope.paths requires paths scope");
  if (textOptions?.include !== undefined && typeof textOptions.include !== "boolean") throw new ViewValidationError("INVALID_REQUEST", "invalid text.include");
  return {
    schemaVersion: 1,
    view: view ? { id: view.id === undefined ? undefined : string(view.id, "view.id")!, deviceId: view.deviceId === undefined ? undefined : string(view.deviceId, "view.deviceId")!, resolution: view.resolution === undefined ? undefined : oneOf(view.resolution, "view.resolution", ["latest-interaction", "require-explicit"] as const) } : undefined,
    scope: kind ? { kind, paths: scopePaths } : undefined,
    text: textOptions ? { include: textOptions.include as boolean | undefined, lastMessages: textOptions.lastMessages === undefined ? undefined : integer(textOptions.lastMessages, "text.lastMessages", 1, 20), maxCharsPerConversation: textOptions.maxCharsPerConversation === undefined ? undefined : integer(textOptions.maxCharsPerConversation, "text.maxCharsPerConversation", 1, 4000) } : undefined,
    caller: caller ? { pid: caller.pid === undefined ? undefined : integer(caller.pid, "caller.pid", 1), transcriptPath: caller.transcriptPath === undefined ? undefined : string(caller.transcriptPath, "caller.transcriptPath")! } : undefined,
  };
}

export async function readBoundedJson(request: Request, maximum = MAX_PRESENCE_BYTES): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maximum) throw new ViewValidationError("PAYLOAD_TOO_LARGE", "payload too large", 413);
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maximum) throw new ViewValidationError("PAYLOAD_TOO_LARGE", "payload too large", 413);
  try { return JSON.parse(body) as unknown; } catch { throw new ViewValidationError("INVALID_REQUEST", "invalid JSON"); }
}
