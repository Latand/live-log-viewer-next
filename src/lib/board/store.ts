import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardFileV1, BoardProjectStateV1 } from "@/lib/view/types";

export const BOARD_FILE = statePath("board.json");
const EMPTY_PREFS: BoardProjectStateV1["prefs"] = { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false };
const BOARD_LOCK_ATTEMPTS = 1_000;
const BOARD_LOCK_WAIT_MS = 5;
const BOARD_LOCK_STALE_MS = 30_000;
let boardFileForTests: string | null = null;

export class BoardStoreError extends Error {
  constructor(message = "board state unavailable") { super(message); }
}

export function setBoardFileForTests(filePath: string | null): void {
  boardFileForTests = filePath;
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function aliases(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}
function projectState(value: unknown): value is BoardProjectStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<BoardProjectStateV1>;
  const prefs = state.prefs;
  return state.schemaVersion === 1 && Number.isInteger(state.revision) && state.revision! >= 0 && typeof state.updatedAt === "string" && Boolean(prefs) &&
    stringArray(prefs!.manual) && stringArray(prefs!.hidden) && stringArray(prefs!.expanded) &&
    (state.explicitManual === undefined || stringArray(state.explicitManual)) &&
    (state.pathAliases === undefined || aliases(state.pathAliases)) &&
    (prefs!.viewMode === null || prefs!.viewMode === "scheme" || prefs!.viewMode === "list") && typeof prefs!.taskPanelOpen === "boolean";
}

function emptyBoard(): BoardProjectStateV1 {
  return { schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [], prefs: { ...EMPTY_PREFS, manual: [], hidden: [], expanded: [] } };
}

function read(filePath: string): BoardFileV1 {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BoardFileV1>;
    if (!parsed || typeof parsed.projects !== "object" || parsed.projects === null || Array.isArray(parsed.projects)) throw new BoardStoreError("invalid board state");
    if (!Object.values(parsed.projects).every(projectState)) throw new BoardStoreError("invalid board project state");
    return { projects: Object.fromEntries(Object.entries(parsed.projects).map(([project, state]) => [project, {
      ...state,
      pathAliases: state.pathAliases ?? {},
      explicitManual: state.explicitManual ?? state.prefs.manual,
    }])) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    if (error instanceof BoardStoreError) throw error;
    throw new BoardStoreError();
  }
}
function write(value: BoardFileV1, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, filePath);
    const directory = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockOwnerIsStale(lockPath: string): boolean {
  try {
    const previous = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; startIdentity?: unknown };
    if (typeof previous.pid === "number" && Number.isInteger(previous.pid) && previous.pid > 0) {
      const identity = typeof previous.startIdentity === "string" ? previous.startIdentity : null;
      return !procBackend.pidAlive(previous.pid)
        || (identity !== null
          ? (() => {
              const currentIdentity = procBackend.processIdentity(previous.pid);
              return currentIdentity !== null && currentIdentity !== identity;
            })()
          : Date.now() - fs.statSync(lockPath).mtimeMs > BOARD_LOCK_STALE_MS);
    }
    return Date.now() - fs.statSync(lockPath).mtimeMs > BOARD_LOCK_STALE_MS;
  } catch {
    try { return Date.now() - fs.statSync(lockPath).mtimeMs > BOARD_LOCK_STALE_MS; } catch { return false; }
  }
}

function removeBoardLockIfOwned(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (owner.token === token) fs.rmSync(lockPath, { force: true });
  } catch { /* another owner already recovered the lock */ }
}

function withBoardWriteLock<T>(filePath: string, operation: () => T): T {
  const lockPath = `${filePath}.write-lock`;
  const queuePath = `${filePath}.write-locks`;
  fs.mkdirSync(queuePath, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), token: crypto.randomUUID() };
  const ticketPath = path.join(
    queuePath,
    `${String(Date.now()).padStart(16, "0")}-${process.pid}-${crypto.randomUUID()}.json`,
  );
  fs.writeFileSync(ticketPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < BOARD_LOCK_ATTEMPTS; attempt += 1) {
      const liveTickets: string[] = [];
      for (const entry of fs.readdirSync(queuePath).filter((candidate) => candidate.endsWith(".json")).sort()) {
        const candidate = path.join(queuePath, entry);
        if (lockOwnerIsStale(candidate)) {
          fs.rmSync(candidate, { force: true });
          continue;
        }
        if (fs.existsSync(candidate)) liveTickets.push(candidate);
      }
      if (liveTickets[0] !== ticketPath) {
        sleep(BOARD_LOCK_WAIT_MS);
        continue;
      }
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (lockOwnerIsStale(lockPath)) fs.rmSync(lockPath, { force: true });
        sleep(BOARD_LOCK_WAIT_MS);
        continue;
      }
      try {
        fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
        fs.fsyncSync(descriptor);
        return operation();
      } finally {
        fs.closeSync(descriptor);
        removeBoardLockIfOwned(lockPath, owner.token);
      }
    }
    throw new BoardStoreError("board state is busy");
  } finally {
    removeBoardLockIfOwned(ticketPath, owner.token);
  }
}

export function boardFor(project: string, filePath = boardFileForTests ?? BOARD_FILE): BoardProjectStateV1 {
  return read(filePath).projects[project] ?? emptyBoard();
}
export type BoardPatch = Partial<BoardProjectStateV1["prefs"]>;
type BoardWriteResult = { ok: true; board: BoardProjectStateV1 } | { ok: false; board: BoardProjectStateV1 };

function applyLegacyPatch(current: BoardProjectStateV1, patch: BoardPatch): BoardProjectStateV1 {
  const hidden = patch.hidden === undefined
    ? current.prefs.hidden
    : [...new Set([...current.prefs.hidden, ...patch.hidden])];
  return applyBoardMutations({
    ...current,
    explicitManual: patch.manual === undefined ? current.explicitManual : patch.manual,
    prefs: { ...current.prefs, ...patch, hidden },
  }, []);
}

function sameReduced(left: BoardProjectStateV1, right: BoardProjectStateV1): boolean {
  return JSON.stringify({ prefs: left.prefs, pathAliases: left.pathAliases ?? {}, explicitManual: left.explicitManual ?? [] })
    === JSON.stringify({ prefs: right.prefs, pathAliases: right.pathAliases ?? {}, explicitManual: right.explicitManual ?? [] });
}

function writeReduced(project: string, baseRevision: number, reduce: (current: BoardProjectStateV1) => BoardProjectStateV1, filePath: string): BoardWriteResult {
  return withBoardWriteLock(filePath, () => {
    const value = read(filePath);
    const current = value.projects[project] ?? emptyBoard();
    const reduced = reduce(current);
    if (sameReduced(current, reduced)) return { ok: true, board: current };
    if (current.revision !== baseRevision) return { ok: false, board: current };
    const next: BoardProjectStateV1 = { ...reduced, schemaVersion: 1, revision: current.revision + 1, updatedAt: new Date().toISOString(), pathAliases: reduced.pathAliases ?? {} };
    value.projects[project] = next;
    write(value, filePath);
    return { ok: true, board: next };
  });
}

function writeLatest(project: string, reduce: (current: BoardProjectStateV1) => BoardProjectStateV1, filePath: string): BoardProjectStateV1 {
  return withBoardWriteLock(filePath, () => {
    const value = read(filePath);
    const current = value.projects[project] ?? emptyBoard();
    const reduced = reduce(current);
    if (sameReduced(current, reduced)) return current;
    const next: BoardProjectStateV1 = {
      ...reduced,
      schemaVersion: 1,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      pathAliases: reduced.pathAliases ?? {},
    };
    value.projects[project] = next;
    write(value, filePath);
    return next;
  });
}

export function patchBoard(project: string, baseRevision: number, patch: BoardPatch, filePath = boardFileForTests ?? BOARD_FILE): { ok: true; board: BoardProjectStateV1 } | { ok: false; board: BoardProjectStateV1 } {
  return writeReduced(project, baseRevision, (current) => applyLegacyPatch(current, patch), filePath);
}

export function mutateBoard(project: string, baseRevision: number, mutations: readonly BoardMutationV1[], filePath = boardFileForTests ?? BOARD_FILE): BoardWriteResult {
  return writeReduced(project, baseRevision, (current) => applyBoardMutations(current, mutations), filePath);
}

export function remapBoardPaths(
  project: string,
  pairs: Extract<BoardMutationV1, { kind: "remap-paths" }>["pairs"],
  options: { provisionalManual?: readonly string[]; filePath?: string } = {},
): BoardProjectStateV1 {
  const filePath = options.filePath ?? boardFileForTests ?? BOARD_FILE;
  return writeLatest(project, (current) => {
    if (pairs.length === 0 || pairs.every(({ from, to }) => current.pathAliases?.[from] === to)) return current;
    const provisionalManual = options.provisionalManual?.filter((pathname) => (
      current.pathAliases?.[pathname] === undefined && current.prefs.manual.includes(pathname)
    )) ?? [];
    const mutations: BoardMutationV1[] = [];
    if (provisionalManual.length) {
      mutations.push({ kind: "reconcile-roots", roots: [], removeManual: provisionalManual });
    }
    mutations.push({ kind: "remap-paths", pairs });
    return applyBoardMutations(current, mutations);
  }, filePath);
}

export function transferBoardPathPlacements(
  transfers: readonly { fromProject: string; toProject: string; paths: readonly string[] }[],
  filePath = boardFileForTests ?? BOARD_FILE,
): void {
  if (transfers.length === 0) return;
  withBoardWriteLock(filePath, () => {
    const value = read(filePath);
    let changed = false;
    for (const transfer of transfers) {
      if (transfer.fromProject === transfer.toProject) continue;
      const storedSource = value.projects[transfer.fromProject];
      if (!storedSource) continue;
      let source = applyBoardMutations(storedSource, []);
      let target = applyBoardMutations(value.projects[transfer.toProject] ?? emptyBoard(), []);
      for (const pathname of [...new Set(transfer.paths)]) {
        const sourceAliasEntries = Object.entries(source.pathAliases ?? {}).filter(([, targetPath]) => targetPath === pathname);
        if (sourceAliasEntries.length > 0) {
          target = applyBoardMutations({
            ...target,
            pathAliases: {
              ...(target.pathAliases ?? {}),
              ...Object.fromEntries(sourceAliasEntries),
            },
          }, []);
        }
        const sourceHasMembership = source.prefs.hidden.includes(pathname)
          || source.prefs.expanded.includes(pathname)
          || source.prefs.manual.includes(pathname);
        if (!sourceHasMembership && sourceAliasEntries.length === 0) continue;
        const sourcePlacement = source.prefs.hidden.includes(pathname)
          ? "hidden"
          : source.prefs.expanded.includes(pathname)
            ? "expanded"
            : source.prefs.manual.includes(pathname)
              ? "manual"
              : "auto";
        const destinationPlacement = target.prefs.hidden.includes(pathname)
          ? "hidden"
          : target.prefs.expanded.includes(pathname)
            ? "expanded"
            : target.prefs.manual.includes(pathname)
              ? "manual"
              : "auto";
        const placement = sourcePlacement === "hidden" || destinationPlacement === "hidden"
          ? "hidden"
          : destinationPlacement !== "auto"
            ? destinationPlacement
            : sourcePlacement;
        const explicitManual = (source.explicitManual ?? []).includes(pathname)
          || (target.explicitManual ?? []).includes(pathname);
        source = {
          ...source,
          explicitManual: (source.explicitManual ?? []).filter((item) => item !== pathname),
          pathAliases: Object.fromEntries(
            Object.entries(source.pathAliases ?? {}).filter(([, targetPath]) => targetPath !== pathname),
          ),
          prefs: {
            ...source.prefs,
            manual: source.prefs.manual.filter((item) => item !== pathname),
            hidden: source.prefs.hidden.filter((item) => item !== pathname),
            expanded: source.prefs.expanded.filter((item) => item !== pathname),
          },
        };
        const targetPrefs = {
          ...target.prefs,
          manual: target.prefs.manual.filter((item) => item !== pathname),
          hidden: target.prefs.hidden.filter((item) => item !== pathname),
          expanded: target.prefs.expanded.filter((item) => item !== pathname),
        };
        target = {
          ...target,
          explicitManual: placement === "manual" && explicitManual
            ? [...(target.explicitManual ?? []).filter((item) => item !== pathname), pathname]
            : (target.explicitManual ?? []).filter((item) => item !== pathname),
          prefs: placement === "hidden"
            ? { ...targetPrefs, hidden: [...targetPrefs.hidden, pathname] }
            : placement === "expanded"
              ? { ...targetPrefs, expanded: [...targetPrefs.expanded, pathname] }
              : placement === "manual"
                ? { ...targetPrefs, manual: [...targetPrefs.manual, pathname] }
                : targetPrefs,
        };
      }
      if (!sameReduced(storedSource, source)) {
        value.projects[transfer.fromProject] = {
          ...source,
          revision: storedSource.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
      const storedTarget = value.projects[transfer.toProject] ?? emptyBoard();
      if (!sameReduced(storedTarget, target)) {
        value.projects[transfer.toProject] = {
          ...target,
          revision: storedTarget.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
    }
    if (changed) write(value, filePath);
  });
}

function mergedBoards(states: readonly BoardProjectStateV1[]): BoardProjectStateV1 {
  const ordered = states
    .map((state, index) => ({ state, index, timestamp: Date.parse(state.updatedAt) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : 0;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : 0;
      return leftTime - rightTime || left.index - right.index;
    })
    .map(({ state }) => state);
  const aliases = ordered.reduce<Record<string, string>>(
    (combined, state) => ({ ...combined, ...(state.pathAliases ?? {}) }),
    {},
  );
  const roles = new Map<string, "manual" | "hidden" | "expanded">();
  let viewMode: BoardProjectStateV1["prefs"]["viewMode"] = null;
  let taskPanelOpen = false;
  let normalizedAliases: Record<string, string> = aliases;
  for (const state of ordered) {
    const normalized = applyBoardMutations({ ...state, pathAliases: aliases }, []);
    normalizedAliases = normalized.pathAliases ?? {};
    for (const role of ["manual", "hidden", "expanded"] as const) {
      for (const pathname of normalized.prefs[role]) {
        roles.delete(pathname);
        roles.set(pathname, role);
      }
    }
    viewMode = normalized.prefs.viewMode;
    taskPanelOpen = normalized.prefs.taskPanelOpen;
  }
  const prefs = {
    manual: [] as string[],
    hidden: [] as string[],
    expanded: [] as string[],
    viewMode,
    taskPanelOpen,
  };
  for (const [pathname, role] of roles) prefs[role].push(pathname);
  const manualSet = new Set(prefs.manual);
  const explicitManual = [...new Set(ordered.flatMap((state) => state.explicitManual ?? []))]
    .map((pathname) => normalizedAliases[pathname] ?? pathname)
    .filter((pathname) => manualSet.has(pathname));
  return { ...ordered.at(-1)!, pathAliases: normalizedAliases, explicitManual, prefs };
}

/** Move durable board preferences along with catalog project-key repairs.
    Sources remain intact whenever a merge cannot preserve board invariants. */
export function migrateBoardProjects(
  migrations: ReadonlyMap<string, string>,
  filePath = boardFileForTests ?? statePath("board.json"),
): boolean {
  if (migrations.size === 0) return true;
  return withBoardWriteLock(filePath, () => {
    const value = read(filePath);
    let changed = false;
    let complete = true;
    const sourcesByTarget = new Map<string, string[]>();
    for (const [sourceProject, targetProject] of migrations) {
      if (sourceProject === targetProject) continue;
      sourcesByTarget.set(targetProject, [...(sourcesByTarget.get(targetProject) ?? []), sourceProject]);
    }
    for (const [targetProject, sourceProjects] of sourcesByTarget) {
      const sources = sourceProjects.flatMap((project) => value.projects[project] ? [value.projects[project]!] : []);
      if (sources.length === 0) continue;
      const target = value.projects[targetProject];
      if (!target && sources.length === 1) {
        value.projects[targetProject] = sources[0]!;
        for (const sourceProject of sourceProjects) delete value.projects[sourceProject];
        changed = true;
        continue;
      }
      try {
        const states = target ? [target, ...sources] : sources;
        const merged = mergedBoards(states);
        value.projects[targetProject] = target && sameReduced(target, merged)
          ? target
          : {
              ...merged,
              revision: Math.max(...states.map((state) => state.revision)) + 1,
              updatedAt: new Date().toISOString(),
            };
        for (const sourceProject of sourceProjects) delete value.projects[sourceProject];
        changed = true;
      } catch {
        complete = false;
        continue;
      }
    }
    if (changed) write(value, filePath);
    return complete;
  });
}
