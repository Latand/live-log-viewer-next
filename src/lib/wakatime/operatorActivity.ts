import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type RegistryFile,
} from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import type { FileEntry } from "@/lib/types";

const FILE_VERSION = 1;
const BUSY_MESSAGE = "WakaTime operator activity is busy";

export interface DirectOperatorWakatimeAction {
  key: string;
  engine: "claude" | "codex";
  project: string;
  atMs: number;
}

interface DirectOperatorActionFile {
  version: 1;
  actions: Record<string, DirectOperatorWakatimeAction>;
}

export interface DirectOperatorWakatimeInput {
  conversationId?: string;
  path?: string;
  idempotencyKey: string;
  fallbackEntry?: FileEntry;
}

interface DirectOperatorWakatimeDependencies {
  filename: string;
  now(): number;
  registrySnapshot(): RegistryFile;
}

function digest(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAction(value: unknown, key: string): DirectOperatorWakatimeAction | null {
  if (!isRecord(value)
    || value.key !== key
    || !/^[a-f0-9]{64}$/.test(key)
    || (value.engine !== "claude" && value.engine !== "codex")
    || typeof value.project !== "string" || !value.project
    || typeof value.atMs !== "number" || !Number.isSafeInteger(value.atMs) || value.atMs <= 0) return null;
  return { key, engine: value.engine, project: value.project, atMs: value.atMs };
}

function readActionFile(filename: string): DirectOperatorActionFile {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: FILE_VERSION, actions: {} };
    throw error;
  }
  if (!isRecord(value) || value.version !== FILE_VERSION || !isRecord(value.actions)) {
    throw new Error("WakaTime operator activity state is invalid");
  }
  const actions: Record<string, DirectOperatorWakatimeAction> = {};
  for (const [key, candidate] of Object.entries(value.actions)) {
    const action = parseAction(candidate, key);
    if (!action) throw new Error("WakaTime operator activity state is invalid");
    actions[key] = action;
  }
  return { version: FILE_VERSION, actions };
}

function writeActionFile(filename: string, value: DirectOperatorActionFile): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

export function directOperatorWakatimeActionFile(): string {
  return statePath("wakatime-operator-actions.json");
}

export function readDirectOperatorWakatimeActions(
  filename: string = directOperatorWakatimeActionFile(),
): DirectOperatorWakatimeAction[] {
  return Object.values(readActionFile(filename).actions)
    .sort((left, right) => left.atMs - right.atMs || left.key.localeCompare(right.key));
}

export function recordDirectOperatorWakatimeActivity(
  input: DirectOperatorWakatimeInput,
  overrides: Partial<DirectOperatorWakatimeDependencies> = {},
): DirectOperatorWakatimeAction {
  const dependencies: DirectOperatorWakatimeDependencies = {
    filename: overrides.filename ?? directOperatorWakatimeActionFile(),
    now: overrides.now ?? Date.now,
    registrySnapshot: overrides.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()),
  };
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("direct operator activity requires an idempotency key");

  const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
  const conversation = input.conversationId?.trim().startsWith("conversation_")
    ? lookup.conversation(input.conversationId.trim() as `conversation_${string}`)
    : input.path ? lookup.conversationForPath(input.path) : null;
  const fallback = input.fallbackEntry;
  const engine = conversation?.engine
    ?? (fallback?.engine === "claude" || fallback?.engine === "codex" ? fallback.engine : null);
  if (!engine) throw new Error("direct operator activity target is unavailable");
  const generation = conversation?.generations.at(-1);
  const project = resolveProjectAttribution({
    projectOwnership: conversation?.projectOwnership,
    cwd: generation?.launchProfile.cwd || fallback?.cwd,
    launchProfileProject: generation?.launchProfile.project,
    fallbackProject: fallback?.project,
  }).project ?? UNRESOLVED_PROJECT;
  /* The authorized ingress supplies this identity once per gesture and reuses
     it for retry, resume, and fan-out. Keeping the target out of the digest makes those
     delivery shapes one operator action even when they address several
     conversations or a successor generation. */
  const key = digest("llv-wakatime-direct-operator-v1", idempotencyKey);
  const action: DirectOperatorWakatimeAction = {
    key,
    engine,
    project,
    atMs: dependencies.now(),
  };
  if (!Number.isSafeInteger(action.atMs) || action.atMs <= 0) throw new Error("direct operator activity time is invalid");

  return withFileTransactionSync(dependencies.filename, BUSY_MESSAGE, () => {
    const state = readActionFile(dependencies.filename);
    const existing = state.actions[key];
    if (existing) return existing;
    state.actions[key] = action;
    writeActionFile(dependencies.filename, state);
    return action;
  });
}

export function acknowledgeDirectOperatorWakatimeActions(
  keys: readonly string[],
  filename: string = directOperatorWakatimeActionFile(),
): void {
  if (keys.length === 0) return;
  const acknowledged = new Set(keys);
  withFileTransactionSync(filename, BUSY_MESSAGE, () => {
    const state = readActionFile(filename);
    const retained = Object.fromEntries(
      Object.entries(state.actions).filter(([key]) => !acknowledged.has(key)),
    );
    if (Object.keys(retained).length === Object.keys(state.actions).length) return;
    writeActionFile(filename, { version: FILE_VERSION, actions: retained });
  });
}
