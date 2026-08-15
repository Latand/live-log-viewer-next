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
const COMPATIBILITY_RETRY_WINDOW_MS = 5_000;

export interface DirectOperatorWakatimeAction {
  key: string;
  engine: "claude" | "codex";
  project: string;
  atMs: number;
  compatibilityFingerprint?: string;
}

interface DirectOperatorActionFile {
  version: 1;
  actions: Record<string, DirectOperatorWakatimeAction>;
}

export interface DirectOperatorWakatimeInput {
  conversationId?: string;
  path?: string;
  idempotencyKey?: string;
  /** Hash-only compatibility identity for old clients that supplied no
      message id. Reused solely inside a short retry window. */
  compatibilityFingerprint?: string;
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
    || typeof value.atMs !== "number" || !Number.isSafeInteger(value.atMs) || value.atMs <= 0
    || (value.compatibilityFingerprint !== undefined
      && (typeof value.compatibilityFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.compatibilityFingerprint)))) return null;
  return {
    key,
    engine: value.engine,
    project: value.project,
    atMs: value.atMs,
    ...(typeof value.compatibilityFingerprint === "string"
      ? { compatibilityFingerprint: value.compatibilityFingerprint }
      : {}),
  };
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
  const idempotencyKey = input.idempotencyKey?.trim() ?? "";
  const compatibilityFingerprint = input.compatibilityFingerprint?.trim() ?? "";
  if (!idempotencyKey && !/^[a-f0-9]{64}$/.test(compatibilityFingerprint)) {
    throw new Error("direct operator activity requires an idempotency key or compatibility fingerprint");
  }

  const lookup = readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
  const suppliedConversationId = input.conversationId?.trim() ?? "";
  const suppliedPath = input.path?.trim() ?? "";
  const byId = suppliedConversationId.startsWith("conversation_")
    ? lookup.conversation(suppliedConversationId as `conversation_${string}`)
    : null;
  const byPath = suppliedPath ? lookup.conversationForPath(suppliedPath) : null;
  const ownedPaths = byId
    ? new Set([
        ...byId.generations.map((generation) => generation.path),
        ...byId.continuityPaths,
        ...byId.abandonedContinuityPaths,
      ])
    : null;
  if ((byId && byPath && byId.id !== byPath.id)
    || (byId && suppliedPath && !ownedPaths?.has(suppliedPath))) {
    throw new Error("direct operator activity has conflicting target evidence");
  }
  const conversation = byId ?? byPath;
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
  const atMs = dependencies.now();
  if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new Error("direct operator activity time is invalid");

  return withFileTransactionSync(dependencies.filename, BUSY_MESSAGE, () => {
    const state = readActionFile(dependencies.filename);
    if (!idempotencyKey) {
      const retry = Object.values(state.actions)
        .filter((candidate) => candidate.compatibilityFingerprint === compatibilityFingerprint
          && candidate.engine === engine
          && candidate.project === project
          && atMs >= candidate.atMs
          && atMs - candidate.atMs < COMPATIBILITY_RETRY_WINDOW_MS)
        .sort((left, right) => right.atMs - left.atMs)[0];
      if (retry) return retry;
    }
    const key = idempotencyKey
      ? digest("llv-wakatime-direct-operator-v1", idempotencyKey)
      : digest("llv-wakatime-direct-operator-compat-v1", compatibilityFingerprint, String(atMs));
    const existing = state.actions[key];
    if (existing) return existing;
    const action: DirectOperatorWakatimeAction = {
      key,
      engine,
      project,
      atMs,
      ...(!idempotencyKey ? { compatibilityFingerprint } : {}),
    };
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
