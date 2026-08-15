import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { emptyWorktimeState } from "./ledger";
import type { WorktimeStateV1 } from "./types";

export function worktimeStatePath(): string {
  return statePath("worktime-state.json");
}

function stateFrom(value: unknown): WorktimeStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worktime state is invalid");
  const state = value as Partial<WorktimeStateV1>;
  if (state.version !== 1
    || !Number.isFinite(state.enabledAtMs)
    || !state.events || typeof state.events !== "object" || Array.isArray(state.events)
    || !state.rollups || typeof state.rollups !== "object" || Array.isArray(state.rollups)
    || !state.catchup || typeof state.catchup !== "object" || Array.isArray(state.catchup)) {
    throw new Error("worktime state is invalid");
  }
  return structuredClone(state as WorktimeStateV1);
}

function defaultRead(filename: string): string | null {
  try {
    return fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readWorktimeState(
  filename: string = worktimeStatePath(),
  now: number = Date.now(),
  dependencies: { read(filename: string): string | null } = { read: defaultRead },
): WorktimeStateV1 {
  const raw = dependencies.read(filename);
  if (raw === null) return emptyWorktimeState(now);
  try {
    return stateFrom(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("worktime state JSON is invalid");
    throw error;
  }
}

function writeWorktimeState(filename: string, state: WorktimeStateV1): void {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or already removed */ }
  }
}

export function mutateWorktimeState<T>(
  filename: string = worktimeStatePath(),
  now: number = Date.now(),
  operation: (state: WorktimeStateV1) => T,
): T {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  return withFileTransactionSync(filename, "worktime state is busy", () => {
    const state = readWorktimeState(filename, now);
    const result = operation(state);
    writeWorktimeState(filename, state);
    return result;
  });
}
