import fs from "node:fs";
import path from "node:path";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { legacyClaudeHome, sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { activeOrchestratorSeatsForMigration, rekeyOrchestratorSeatPaths } from "@/lib/orchestrator/seats";
import { searchTextForTranscript } from "@/lib/scanner/describe";
import { durableSemanticTitle } from "@/lib/title";

import { agentRegistry, type AgentRegistry } from "./registry";
import type {
  IdentityWaveMigrationResult,
  IdentityWavePathRekey,
  IdentityWaveSeat,
  IdentityWaveSharedPathCandidate,
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

export function runIdentityWaveMigrationAtStartup(
  overrides: Partial<IdentityWaveStartupDependencies> = {},
): IdentityWaveMigrationResult {
  const dependencies: IdentityWaveStartupDependencies = {
    registry: overrides.registry ?? agentRegistry(),
    seats: overrides.seats ?? activeOrchestratorSeatsForMigration,
    now: overrides.now ?? (() => new Date().toISOString()),
    transcriptTitle: overrides.transcriptTitle ?? titleFromTranscriptHead,
    sharedPath: overrides.sharedPath ?? sharedPathForLegacyClaudeTranscript,
    commitExternalPathRekeys: overrides.commitExternalPathRekeys ?? rekeyOrchestratorSeatPaths,
    log: overrides.log ?? ((message, detail) => console.info(message, detail)),
    env: overrides.env ?? process.env,
  };
  const dryRun = dependencies.env.LLV_IDENTITY_WAVE_DRY_RUN === "1";
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
