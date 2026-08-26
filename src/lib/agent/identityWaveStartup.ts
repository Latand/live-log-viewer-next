import fs from "node:fs";
import path from "node:path";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { legacyClaudeHome, sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { statePath } from "@/lib/configDir";
import { activeOrchestratorSeatsForMigration, rekeyOrchestratorSeatPaths } from "@/lib/orchestrator/seats";
import { searchTextForTranscript } from "@/lib/scanner/describe";
import { durableSemanticTitle } from "@/lib/title";

import { agentRegistry, normalizeRegistry, RegistryReadError, type AgentRegistry, type RegistryFile } from "./registry";
import { resolveRegistryBackend } from "./registryBackendIdentity";
import { reboundAssembledMcpGrants } from "./mcpAllowlist";
import {
  applyIdentityWaveMigration,
  type IdentityWaveMigrationInput,
  type IdentityWaveMigrationResult,
  type IdentityWavePathRekey,
  type IdentityWaveSeat,
  type IdentityWaveSharedPathCandidate,
} from "./identityWaveMigration";

function evidenceIsAbsent(error: unknown): boolean {
  const code = error && typeof error === "object"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function durableEvidenceHead(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const firstNonEmptyLine = value.split(/\r?\n/).find((line) => line.trim());
  return durableSemanticTitle(firstNonEmptyLine, 120);
}

export function titleFromTranscriptHead(pathname: string, engine: "claude" | "codex"): string | null {
  try {
    const stat = fs.statSync(pathname);
    if (!stat.isFile()) return null;
    const text = searchTextForTranscript(pathname, stat.size, engine);
    return durableEvidenceHead(text.title) ?? durableEvidenceHead(text.firstPrompt);
  } catch (error) {
    if (evidenceIsAbsent(error)) return null;
    throw error;
  }
}

export function sharedPathForLegacyClaudeTranscript(
  pathname: string,
  legacyProjectsRoot = path.join(legacyClaudeHome(), "projects"),
  sharedProjectsRoot = sharedClaudeProjectsRoot(),
): IdentityWaveSharedPathCandidate | null {
  const relative = path.relative(legacyProjectsRoot, pathname);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const candidate = path.join(sharedProjectsRoot, relative);
  if (candidate === pathname) return null;
  try {
    const candidateStat = fs.statSync(candidate);
    if (!candidateStat.isFile()) return null;
    let canonicalRootsMatch = false;
    try {
      canonicalRootsMatch = fs.realpathSync.native(legacyProjectsRoot) === fs.realpathSync.native(sharedProjectsRoot);
    } catch (error) {
      if (!evidenceIsAbsent(error)) throw error;
    }
    let sourceFileMatches = false;
    try {
      const sourceStat = fs.statSync(pathname);
      sourceFileMatches = sourceStat.isFile()
        && sourceStat.dev === candidateStat.dev
        && sourceStat.ino === candidateStat.ino;
    } catch (error) {
      if (!evidenceIsAbsent(error)) throw error;
    }
    return {
      sharedPath: candidate,
      identityEquivalent: canonicalRootsMatch || sourceFileMatches,
    };
  } catch (error) {
    if (evidenceIsAbsent(error)) return null;
    throw error;
  }
}

export interface IdentityWaveStartupDependencies {
  registry: Pick<AgentRegistry, "runIdentityWaveMigration">;
  seats(): readonly IdentityWaveSeat[];
  now(): string;
  transcriptTitle(pathname: string, engine: "claude" | "codex"): string | null;
  sharedPath(pathname: string): IdentityWaveSharedPathCandidate | null;
  commitExternalPathRekeys(rekeys: readonly IdentityWavePathRekey[]): void;
  log(message: string, detail: Record<string, unknown>): void;
  env: Readonly<Record<string, string | undefined>>;
}

type StartupEnvironment = IdentityWaveStartupDependencies["env"];

function readRegistryPayload(filename: string): string | null {
  try {
    return fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RegistryReadError(`agent registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The registry as a dry-run is allowed to see it. Constructing `AgentRegistry`
    is a write path even for a reader: the process-wide instance publishes its
    backend identity descriptor, compacts `agent-registry.json` at startup,
    creates the SQLite store on its first boot and refreshes the rollback
    mirror. A preview of the operator's state must do none of that, so this
    takes the writer's identity gate (an unprovable backend identity refuses
    here exactly as `agentRegistry()` refuses) and then parses the JSON file the
    way the JSON reader does. In the SQLite-authoritative modes that file is the
    revision-stamped rollback mirror the writer refreshes at every start and on
    its checkpoint cadence; an absent or unstamped mirror is refused, because a
    preview built from it would describe stale state as current. */
export function readIdentityWaveRegistrySnapshot(
  filename = statePath("agent-registry.json"),
  env: StartupEnvironment = process.env,
): RegistryFile {
  const backend = resolveRegistryBackend(filename, env);
  const sqliteAuthoritative = backend.mode === "read" || backend.mode === "sqlite";
  const payload = readRegistryPayload(filename);
  if (payload === null) {
    if (sqliteAuthoritative) {
      throw new RegistryReadError(
        `agent registry dry-run cannot preview the ${backend.mode} backend: the JSON rollback mirror is absent;`
        + " start the registry writer once so it refreshes the mirror",
      );
    }
    return normalizeRegistry({ version: 2, entries: {}, receipts: {} });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new RegistryReadError(`agent registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sqliteAuthoritative) {
    const revision = (parsed as { _sqliteRevision?: unknown } | null)?._sqliteRevision;
    if (!Number.isInteger(revision) || Number(revision) < 0) {
      throw new RegistryReadError(
        `agent registry dry-run cannot preview the ${backend.mode} backend: the JSON rollback mirror carries no SQLite revision stamp;`
        + " start the registry writer once so it refreshes the mirror",
      );
    }
  }
  return reboundAssembledMcpGrants(normalizeRegistry(parsed));
}

/** A registry that can only preview. Every call is forced to `dryRun`, so the
    pure migration runs over a private copy and nothing reaches the disk. */
export function readOnlyIdentityWaveRegistry(
  filename?: string,
  env: StartupEnvironment = process.env,
): Pick<AgentRegistry, "runIdentityWaveMigration"> {
  return {
    runIdentityWaveMigration(input: IdentityWaveMigrationInput): IdentityWaveMigrationResult {
      return applyIdentityWaveMigration(readIdentityWaveRegistrySnapshot(filename, env), { ...input, dryRun: true });
    },
  };
}

export function runIdentityWaveMigrationAtStartup(
  overrides: Partial<IdentityWaveStartupDependencies> = {},
): IdentityWaveMigrationResult {
  const env = overrides.env ?? process.env;
  /* Decided before the registry is chosen. The default writer construction is
     itself a state mutation (identity publish, startup compaction, first
     SQLite boot, mirror refresh), which a dry-run must never trigger. */
  const dryRun = env.LLV_IDENTITY_WAVE_DRY_RUN === "1";
  const dependencies: IdentityWaveStartupDependencies = {
    registry: overrides.registry ?? (dryRun ? readOnlyIdentityWaveRegistry(undefined, env) : agentRegistry()),
    seats: overrides.seats ?? activeOrchestratorSeatsForMigration,
    now: overrides.now ?? (() => new Date().toISOString()),
    transcriptTitle: overrides.transcriptTitle ?? titleFromTranscriptHead,
    sharedPath: overrides.sharedPath ?? sharedPathForLegacyClaudeTranscript,
    commitExternalPathRekeys: overrides.commitExternalPathRekeys ?? rekeyOrchestratorSeatPaths,
    log: overrides.log ?? ((message, detail) => console.info(message, detail)),
    env,
  };
  const migrate = () => dependencies.registry.runIdentityWaveMigration({
    dryRun,
    now: dependencies.now(),
    transcriptTitle: dependencies.transcriptTitle,
    sharedPathForLegacy: dependencies.sharedPath,
    orchestratorSeats: dependencies.seats(),
    commitExternalPathRekeys: dependencies.commitExternalPathRekeys,
  });
  const result = dryRun ? migrate() : withAccountMutationLock(migrate);
  dependencies.log("[identity-wave] registry migration", {
    dryRun: result.dryRun,
    alreadyCompleted: result.alreadyCompleted,
    retitled: result.retitled,
    rekeyed: result.rekeyed,
    quarantinedRekeys: result.quarantinedRekeys,
    edgesStamped: result.edgesStamped,
  });
  return result;
}
