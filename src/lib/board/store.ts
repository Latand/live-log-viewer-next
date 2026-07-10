import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { BoardFileV1, BoardProjectStateV1 } from "@/lib/view/types";

export const BOARD_FILE = statePath("board.json");
const EMPTY_PREFS: BoardProjectStateV1["prefs"] = { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false };

export class BoardStoreError extends Error {
  constructor(message = "board state unavailable") { super(message); }
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function projectState(value: unknown): value is BoardProjectStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<BoardProjectStateV1>;
  const prefs = state.prefs;
  return state.schemaVersion === 1 && Number.isInteger(state.revision) && state.revision! >= 0 && typeof state.updatedAt === "string" && Boolean(prefs) &&
    stringArray(prefs!.manual) && stringArray(prefs!.hidden) && stringArray(prefs!.expanded) &&
    (prefs!.viewMode === null || prefs!.viewMode === "scheme" || prefs!.viewMode === "list") && typeof prefs!.taskPanelOpen === "boolean";
}

function emptyBoard(): BoardProjectStateV1 {
  return { schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), prefs: { ...EMPTY_PREFS, manual: [], hidden: [], expanded: [] } };
}

function read(filePath: string): BoardFileV1 {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BoardFileV1>;
    if (!parsed || typeof parsed.projects !== "object" || parsed.projects === null || Array.isArray(parsed.projects)) throw new BoardStoreError("invalid board state");
    if (!Object.values(parsed.projects).every(projectState)) throw new BoardStoreError("invalid board project state");
    return { projects: parsed.projects };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    if (error instanceof BoardStoreError) throw error;
    throw new BoardStoreError();
  }
}
function write(value: BoardFileV1, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}
export function boardFor(project: string, filePath = BOARD_FILE): BoardProjectStateV1 {
  return read(filePath).projects[project] ?? emptyBoard();
}
export type BoardPatch = Partial<BoardProjectStateV1["prefs"]>;
export function patchBoard(project: string, baseRevision: number, patch: BoardPatch, filePath = BOARD_FILE): { ok: true; board: BoardProjectStateV1 } | { ok: false; board: BoardProjectStateV1 } {
  const value = read(filePath);
  const current = value.projects[project] ?? emptyBoard();
  if (current.revision !== baseRevision) return { ok: false, board: current };
  const next: BoardProjectStateV1 = { schemaVersion: 1, revision: current.revision + 1, updatedAt: new Date().toISOString(), prefs: { ...current.prefs, ...patch } };
  value.projects[project] = next;
  write(value, filePath);
  return { ok: true, board: next };
}
