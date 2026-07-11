import type { BoardProjectStateV1 } from "@/lib/view/types";
import { readBoundedJson, ViewValidationError } from "@/lib/view/validation";
import type { BoardMutationV1 } from "@/lib/board/mutations";

/* Must admit every request shape the client transport emits, or a legal
   write becomes untransportable and the client can only drop it. The board
   store's `patchPrefix` ships a byte-heavy mutation alone, so the largest
   client-emittable bodies are one maximal mutation and the one-time seed
   patch. True worst case under JSON escaping (a control character costs six
   bytes, so one 4096-char path serializes to ~24.6 KB): a reconcile carries
   two full 512-path lists (~25.2 MB) and the legacy-seed patch form carries
   three (manual/hidden/expanded, ~37.7 MB). 48 MB covers both with headroom.
   A hand-crafted 128-mutation array of maximal reconciles exceeds any
   reasonable bound and correctly draws 413. The real guards are the
   item-level limits; this cap only fences unbounded bodies on a
   localhost-only endpoint. */
export const MAX_BOARD_BODY_BYTES = 48 * 1024 * 1024;
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

function validPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value;
}
function mutation(value: unknown, index: number): BoardMutationV1 {
  const raw = record(value, `mutations[${index}]`);
  if (typeof raw.kind !== "string") throw new ViewValidationError("INVALID_REQUEST", `invalid mutations[${index}].kind`);
  if (raw.kind === "close") {
    exact(raw, ["kind", "path"], `mutations[${index}]`);
    return { kind: "close", path: validPath(raw.path, `mutations[${index}].path`) };
  }
  if (raw.kind === "restore") {
    exact(raw, ["kind", "path", "placement"], `mutations[${index}]`);
    if (raw.placement !== "auto" && raw.placement !== "manual" && raw.placement !== "expanded") throw new ViewValidationError("INVALID_REQUEST", `invalid mutations[${index}].placement`);
    return { kind: "restore", path: validPath(raw.path, `mutations[${index}].path`), placement: raw.placement };
  }
  if (raw.kind === "reconcile-roots") {
    exact(raw, ["kind", "roots", "removeManual"], `mutations[${index}]`);
    return { kind: "reconcile-roots", roots: pathList(raw.roots, `mutations[${index}].roots`), removeManual: pathList(raw.removeManual, `mutations[${index}].removeManual`) };
  }
  if (raw.kind === "remap-paths") {
    exact(raw, ["kind", "pairs"], `mutations[${index}]`);
    if (!Array.isArray(raw.pairs) || raw.pairs.length === 0 || raw.pairs.length > 512) throw new ViewValidationError("INVALID_REQUEST", `invalid mutations[${index}].pairs`);
    const pairs = raw.pairs.map((pair, pairIndex) => {
      const item = record(pair, `mutations[${index}].pairs[${pairIndex}]`);
      exact(item, ["from", "to"], `mutations[${index}].pairs[${pairIndex}]`);
      return { from: validPath(item.from, `mutations[${index}].pairs[${pairIndex}].from`), to: validPath(item.to, `mutations[${index}].pairs[${pairIndex}].to`) };
    });
    if (new Set(pairs.map((pair) => pair.from)).size !== pairs.length) throw new ViewValidationError("INVALID_REQUEST", `duplicate mutations[${index}].pairs.from`);
    const aliases = Object.fromEntries(pairs.map((pair) => [pair.from, pair.to]));
    for (const source of Object.keys(aliases)) {
      const seen = new Set<string>();
      let path = source;
      while (aliases[path] !== undefined) {
        if (seen.has(path)) throw new ViewValidationError("INVALID_REQUEST", `alias cycle in mutations[${index}]`);
        seen.add(path);
        path = aliases[path]!;
      }
    }
    return { kind: "remap-paths", pairs };
  }
  if (raw.kind === "set-presentation") {
    exact(raw, ["kind", "viewMode", "taskPanelOpen"], `mutations[${index}]`);
    if (raw.viewMode === undefined && raw.taskPanelOpen === undefined) throw new ViewValidationError("INVALID_REQUEST", `empty mutations[${index}]`);
    if (raw.viewMode !== undefined && raw.viewMode !== null && raw.viewMode !== "scheme" && raw.viewMode !== "list") throw new ViewValidationError("INVALID_REQUEST", `invalid mutations[${index}].viewMode`);
    if (raw.taskPanelOpen !== undefined && typeof raw.taskPanelOpen !== "boolean") throw new ViewValidationError("INVALID_REQUEST", `invalid mutations[${index}].taskPanelOpen`);
    return { kind: "set-presentation", ...(raw.viewMode === undefined ? {} : { viewMode: raw.viewMode }), ...(raw.taskPanelOpen === undefined ? {} : { taskPanelOpen: raw.taskPanelOpen }) };
  }
  throw new ViewValidationError("INVALID_REQUEST", `invalid mutations[${index}].kind`);
}

function rejectMutationAliasCycles(mutations: readonly BoardMutationV1[]): void {
  const pairs = mutations.flatMap((item) => item.kind === "remap-paths" ? item.pairs : []);
  if (new Set(pairs.map((pair) => pair.from)).size !== pairs.length) throw new ViewValidationError("INVALID_REQUEST", "duplicate remap source");
  const aliases = Object.fromEntries(pairs.map((pair) => [pair.from, pair.to]));
  for (const source of Object.keys(aliases)) {
    const seen = new Set<string>();
    let path = source;
    while (aliases[path] !== undefined) {
      if (seen.has(path)) throw new ViewValidationError("INVALID_REQUEST", "alias cycle in mutations");
      seen.add(path);
      path = aliases[path]!;
    }
  }
}

export async function validateBoardPatchRequest(request: Request): Promise<{ project: string; baseRevision: number; patch?: BoardPatch; mutations?: BoardMutationV1[] }> {
  const body = record(await readBoundedJson(request, MAX_BOARD_BODY_BYTES), "request");
  exact(body, ["schemaVersion", "project", "baseRevision", "patch", "mutations"], "request");
  if (body.schemaVersion !== 1) throw new ViewValidationError("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be 1");
  if (typeof body.project !== "string" || body.project.length === 0 || body.project.length > 256) throw new ViewValidationError("INVALID_REQUEST", "invalid project");
  if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) throw new ViewValidationError("INVALID_REQUEST", "invalid baseRevision");
  if ((body.patch === undefined) === (body.mutations === undefined)) throw new ViewValidationError("INVALID_REQUEST", "provide exactly one of patch or mutations");
  if (body.mutations !== undefined) {
    if (!Array.isArray(body.mutations) || body.mutations.length === 0 || body.mutations.length > 128) throw new ViewValidationError("INVALID_REQUEST", "invalid mutations");
    const mutations = body.mutations.map(mutation);
    rejectMutationAliasCycles(mutations);
    return { project: body.project, baseRevision: body.baseRevision as number, mutations };
  }
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
