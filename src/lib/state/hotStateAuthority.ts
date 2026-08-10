import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withFileTransactionSync } from "./fileTransaction";

export const HOT_STATE_BACKEND = "sqlite-v1" as const;
export const HOT_STATE_AUTHORITY_FILENAME = "hot-state-authority.json";
export const HOT_STATE_RELEASE_REVISION_ENV = "LLV_HOT_STATE_RELEASE_REVISION";

export type HotStateAuthorityMode = "legacy" | "preparing" | "sqlite" | "fencing";

export interface HotStateCheckpoint {
  acknowledgedAt: string;
  revisions: {
    flows: number;
    pipelines: number;
    pipelinesArchive: number;
    workflows: number;
  };
}

export interface HotStateAuthority {
  schemaVersion: 1;
  epoch: number;
  mode: HotStateAuthorityMode;
  releaseRevision: string | null;
  updatedAt: string;
  activationReadyAt?: string;
  releaseReadyAt?: string;
  checkpoint?: HotStateCheckpoint;
}

type ReleaseTarget = {
  endpoint: string;
  revision: string;
  hotStateBackend?: typeof HOT_STATE_BACKEND;
};

function authorityFile(directory: string): string {
  return path.join(directory, HOT_STATE_AUTHORITY_FILENAME);
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validCheckpoint(value: unknown): value is HotStateCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Partial<HotStateCheckpoint>;
  const revisions = checkpoint.revisions;
  const values = revisions
    ? [revisions.flows, revisions.pipelines, revisions.pipelinesArchive, revisions.workflows]
    : [];
  return typeof checkpoint.acknowledgedAt === "string"
    && values.length === 4
    && values.every((revision) => Number.isInteger(revision) && revision >= 0);
}

function parseAuthority(value: unknown): HotStateAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authority = value as Partial<HotStateAuthority>;
  if (authority.schemaVersion !== 1
    || !Number.isInteger(authority.epoch)
    || (authority.epoch as number) < 1
    || !["legacy", "preparing", "sqlite", "fencing"].includes(String(authority.mode))
    || (authority.releaseRevision !== null && !validRevision(authority.releaseRevision))
    || typeof authority.updatedAt !== "string"
    || (authority.activationReadyAt !== undefined && typeof authority.activationReadyAt !== "string")
    || (authority.releaseReadyAt !== undefined && typeof authority.releaseReadyAt !== "string")
    || (authority.releaseReadyAt !== undefined && authority.activationReadyAt === undefined)
    || (authority.checkpoint !== undefined && !validCheckpoint(authority.checkpoint))) return null;
  return authority as HotStateAuthority;
}

function parseTarget(value: unknown): ReleaseTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Partial<ReleaseTarget>;
  if (typeof target.endpoint !== "string" || !validRevision(target.revision)) return null;
  if (target.hotStateBackend !== undefined && target.hotStateBackend !== HOT_STATE_BACKEND) return null;
  return target as ReleaseTarget;
}

function durableAtomicWrite(filename: string, value: unknown): void {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  const directoryDescriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}

export function readHotStateAuthority(directory: string): HotStateAuthority | null {
  try {
    const parsed = parseAuthority(JSON.parse(fs.readFileSync(authorityFile(directory), "utf8")) as unknown);
    if (!parsed) throw new Error("hot-state authority is invalid");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readHotStateReleaseTarget(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseTarget | null {
  const filename = env.LLV_VIEWER_DEPLOY_TARGET?.trim() || path.join(directory, "viewer-release.json");
  try {
    const parsed = parseTarget(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
    if (!parsed) throw new Error("Viewer release target cannot authorize hot state");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function hotStateWriterRevision(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const target = readHotStateReleaseTarget(directory, env);
  if (!target) return null;
  const explicit = env[HOT_STATE_RELEASE_REVISION_ENV]?.trim();
  if (explicit) return validRevision(explicit) && explicit === target.revision ? explicit : null;
  const port = env.PORT?.trim();
  if (!port) return null;
  try {
    return new URL(target.endpoint).port === port ? target.revision : null;
  } catch {
    return null;
  }
}

export function hotStateSqliteWriterReady(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const target = readHotStateReleaseTarget(directory, env);
  if (!target) return true;
  const authority = readHotStateAuthority(directory);
  /* Fencing covers the handoff window, when a retiring and an arriving release
     could both write. Unidentified local clients may write after the promoted
     release activates settled SQLite state. A client carrying PORT or an
     explicit revision remains bound to that identity, so a retiring server or
     MCP process stays fenced after the target changes (issue #907 follow-up). */
  const revision = hotStateWriterRevision(directory, env);
  if (!revision) {
    const carriesReleaseIdentity = Boolean(
      env[HOT_STATE_RELEASE_REVISION_ENV]?.trim() || env.PORT?.trim(),
    );
    return !carriesReleaseIdentity
      && authority?.mode === "sqlite"
      && authority.releaseRevision === target.revision
      && typeof authority.activationReadyAt === "string";
  }
  return authority?.mode === "sqlite"
    && authority.releaseRevision === revision
    && target.revision === revision;
}

export function hotStatePreparingWriterReady(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const target = readHotStateReleaseTarget(directory, env);
  if (!target) return true;
  const revision = hotStateWriterRevision(directory, env);
  if (!revision) return false;
  const authority = readHotStateAuthority(directory);
  return authority?.mode === "preparing"
    && authority.releaseRevision === revision
    && target.revision === revision;
}

function sameAuthority(left: HotStateAuthority | null, right: HotStateAuthority): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function writeHotStateAuthority(
  directory: string,
  previous: HotStateAuthority | null,
  mode: HotStateAuthorityMode,
  releaseRevision: string | null,
  options: {
    checkpoint?: HotStateCheckpoint;
    epoch?: number;
    activationReadyAt?: string;
    releaseReadyAt?: string;
  } = {},
): HotStateAuthority {
  if (options.releaseReadyAt && !options.activationReadyAt) {
    throw new Error("Viewer release readiness requires completed hot-state activation");
  }
  const authority: HotStateAuthority = {
    schemaVersion: 1,
    epoch: options.epoch ?? ((previous?.epoch ?? 0) + 1),
    mode,
    releaseRevision,
    updatedAt: new Date().toISOString(),
    ...(options.activationReadyAt ? { activationReadyAt: options.activationReadyAt } : {}),
    ...(options.releaseReadyAt ? { releaseReadyAt: options.releaseReadyAt } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
  };
  if (!Number.isInteger(authority.epoch) || authority.epoch < 1) throw new Error("hot-state authority epoch is invalid");
  if (previous && authority.epoch < previous.epoch) throw new Error("hot-state authority epoch cannot regress");
  durableAtomicWrite(authorityFile(directory), authority);
  return authority;
}

export function publishHotStateAuthority(
  directory: string,
  mode: HotStateAuthorityMode,
  releaseRevision: string | null,
  options: { checkpoint?: HotStateCheckpoint; epoch?: number; activationReadyAt?: string; releaseReadyAt?: string } = {},
): HotStateAuthority {
  if (releaseRevision !== null && !validRevision(releaseRevision)) throw new Error("hot-state release revision is invalid");
  return withFileTransactionSync(authorityFile(directory), "hot-state authority is busy", () =>
    writeHotStateAuthority(directory, readHotStateAuthority(directory), mode, releaseRevision, options));
}

/** Restore the previous semantic state through a newer epoch if the transient
 * transition is still current. A delayed acknowledgement or newer handoff
 * makes the compare-and-set fail without changing authority. */
export function restoreHotStateAuthority(
  directory: string,
  authority: HotStateAuthority | null,
  expectedCurrent: HotStateAuthority,
): HotStateAuthority | null {
  return withFileTransactionSync(authorityFile(directory), "hot-state authority is busy", () => {
    const current = readHotStateAuthority(directory);
    if (!sameAuthority(current, expectedCurrent)) return null;
    return writeHotStateAuthority(
      directory,
      current,
      authority?.mode ?? "legacy",
      authority?.releaseRevision ?? null,
      {
        ...(authority?.checkpoint ? { checkpoint: authority.checkpoint } : {}),
        ...(authority?.activationReadyAt ? { activationReadyAt: authority.activationReadyAt } : {}),
        ...(authority?.releaseReadyAt ? { releaseReadyAt: authority.releaseReadyAt } : {}),
        epoch: current!.epoch + 1,
      },
    );
  });
}

export function acknowledgeHotStateFence(
  directory: string,
  request: Pick<HotStateAuthority, "epoch" | "releaseRevision">,
  revisions: HotStateCheckpoint["revisions"],
): HotStateAuthority {
  return withFileTransactionSync(authorityFile(directory), "hot-state authority is busy", () => {
    const current = readHotStateAuthority(directory);
    if (!current
      || current.mode !== "fencing"
      || current.epoch !== request.epoch
      || current.releaseRevision !== request.releaseRevision
      || current.checkpoint) {
      throw new Error("hot-state fence request changed before checkpoint acknowledgement");
    }
    return writeHotStateAuthority(directory, current, "fencing", current.releaseRevision, {
      epoch: current.epoch,
      checkpoint: { acknowledgedAt: new Date().toISOString(), revisions },
    });
  });
}

export function completeHotStatePreparation(
  directory: string,
  request: HotStateAuthority,
): HotStateAuthority {
  return withFileTransactionSync(authorityFile(directory), "hot-state authority is busy", () => {
    const current = readHotStateAuthority(directory);
    if (!current || !sameAuthority(current, request) || current.mode !== "preparing") {
      throw new Error("hot-state preparation changed before completion");
    }
    return writeHotStateAuthority(directory, current, "sqlite", current.releaseRevision, {
      epoch: current.epoch,
    });
  });
}

export function markHotStateActivationReady(
  directory: string,
  request: HotStateAuthority,
): HotStateAuthority {
  return withFileTransactionSync(authorityFile(directory), "hot-state authority is busy", () => {
    const current = readHotStateAuthority(directory);
    if (!current || !sameAuthority(current, request) || current.mode !== "sqlite") {
      throw new Error("hot-state authority changed before activation completed");
    }
    return writeHotStateAuthority(directory, current, "sqlite", current.releaseRevision, {
      epoch: current.epoch,
      activationReadyAt: new Date().toISOString(),
    });
  });
}

export function markViewerReleaseReady(
  directory: string,
  request: HotStateAuthority,
): HotStateAuthority {
  return withFileTransactionSync(authorityFile(directory), "hot-state authority is busy", () => {
    const current = readHotStateAuthority(directory);
    if (!current
      || !sameAuthority(current, request)
      || current.mode !== "sqlite"
      || typeof current.activationReadyAt !== "string") {
      throw new Error("hot-state authority changed before Viewer release startup completed");
    }
    return writeHotStateAuthority(directory, current, "sqlite", current.releaseRevision, {
      epoch: current.epoch,
      activationReadyAt: current.activationReadyAt,
      releaseReadyAt: new Date().toISOString(),
    });
  });
}
