import fs from "node:fs";
import path from "node:path";

import { legacyClaudeHome, sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { activeOrchestratorSeatsForMigration, rekeyOrchestratorSeatPaths } from "@/lib/orchestrator/seats";
import { rekeyOrchestratorRecordPath } from "@/lib/orchestrator/store";
import { searchTextForTranscript } from "@/lib/scanner/describe";
import { semanticTitle } from "@/lib/title";

import { agentRegistry, type AgentRegistry } from "./registry";
import type { IdentityWaveMigrationResult, IdentityWavePathRekey, IdentityWaveSeat } from "./identityWaveMigration";

function evidenceIsAbsent(error: unknown): boolean {
  const code = error && typeof error === "object"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function titleFromTranscriptHead(pathname: string, engine: "claude" | "codex"): string | null {
  try {
    const stat = fs.statSync(pathname);
    if (!stat.isFile()) return null;
    const text = searchTextForTranscript(pathname, stat.size, engine);
    return semanticTitle(text.title) ?? semanticTitle(text.firstPrompt);
  } catch (error) {
    if (evidenceIsAbsent(error)) return null;
    throw error;
  }
}

export function sharedPathForLegacyClaudeTranscript(
  pathname: string,
  legacyProjectsRoot = path.join(legacyClaudeHome(), "projects"),
  sharedProjectsRoot = sharedClaudeProjectsRoot(),
): string | null {
  const relative = path.relative(legacyProjectsRoot, pathname);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const candidate = path.join(sharedProjectsRoot, relative);
  if (candidate === pathname) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
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
  sharedPath(pathname: string): string | null;
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
    commitExternalPathRekeys: overrides.commitExternalPathRekeys ?? ((rekeys) => {
      rekeyOrchestratorSeatPaths(rekeys);
      rekeyOrchestratorRecordPath(rekeys);
    }),
    log: overrides.log ?? ((message, detail) => console.info(message, detail)),
    env: overrides.env ?? process.env,
  };
  const result = dependencies.registry.runIdentityWaveMigration({
    dryRun: dependencies.env.LLV_IDENTITY_WAVE_DRY_RUN === "1",
    now: dependencies.now(),
    transcriptTitle: dependencies.transcriptTitle,
    sharedPathForLegacy: dependencies.sharedPath,
    orchestratorSeats: dependencies.seats(),
    commitExternalPathRekeys: dependencies.commitExternalPathRekeys,
  });
  dependencies.log("[identity-wave] registry migration", {
    dryRun: result.dryRun,
    alreadyCompleted: result.alreadyCompleted,
    retitled: result.retitled,
    rekeyed: result.rekeyed,
    edgesStamped: result.edgesStamped,
  });
  return result;
}
