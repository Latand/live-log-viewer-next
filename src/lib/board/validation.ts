import type { BoardProjectStateV1 } from "@/lib/view/types";
import { readBoundedJson, ViewValidationError } from "@/lib/view/validation";

export const MAX_BOARD_BODY_BYTES = 32 * 1024;
export type BoardPatch = Partial<BoardProjectStateV1["prefs"]>;

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ViewValidationError("INVALID_REQUEST", `unknown ${field}.${unknown}`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value as Record<string, unknown>;
}
function pathList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 512 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 4096)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  if (new Set(value).size !== value.length) throw new ViewValidationError("INVALID_REQUEST", `duplicate ${field}`);
  return value as string[];
}

export async function validateBoardPatchRequest(request: Request): Promise<{ project: string; baseRevision: number; patch: BoardPatch }> {
  const body = record(await readBoundedJson(request, MAX_BOARD_BODY_BYTES), "request");
  exact(body, ["schemaVersion", "project", "baseRevision", "patch"], "request");
  if (body.schemaVersion !== 1) throw new ViewValidationError("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be 1");
  if (typeof body.project !== "string" || body.project.length === 0 || body.project.length > 256) throw new ViewValidationError("INVALID_REQUEST", "invalid project");
  if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) throw new ViewValidationError("INVALID_REQUEST", "invalid baseRevision");
  const rawPatch = record(body.patch, "patch"); exact(rawPatch, ["manual", "hidden", "expanded", "viewMode", "taskPanelOpen"], "patch");
  if (Object.keys(rawPatch).length === 0) throw new ViewValidationError("INVALID_REQUEST", "empty patch");
  const patch: BoardPatch = {};
  if (rawPatch.manual !== undefined) patch.manual = pathList(rawPatch.manual, "patch.manual");
  if (rawPatch.hidden !== undefined) patch.hidden = pathList(rawPatch.hidden, "patch.hidden");
  if (rawPatch.expanded !== undefined) patch.expanded = pathList(rawPatch.expanded, "patch.expanded");
  if (rawPatch.viewMode !== undefined) {
    if (rawPatch.viewMode !== null && rawPatch.viewMode !== "scheme" && rawPatch.viewMode !== "list") throw new ViewValidationError("INVALID_REQUEST", "invalid patch.viewMode");
    patch.viewMode = rawPatch.viewMode;
  }
  if (rawPatch.taskPanelOpen !== undefined) {
    if (typeof rawPatch.taskPanelOpen !== "boolean") throw new ViewValidationError("INVALID_REQUEST", "invalid patch.taskPanelOpen");
    patch.taskPanelOpen = rawPatch.taskPanelOpen;
  }
  return { project: body.project, baseRevision: body.baseRevision as number, patch };
}
