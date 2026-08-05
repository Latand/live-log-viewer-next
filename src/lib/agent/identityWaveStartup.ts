import fs from "node:fs";
import path from "node:path";

import { legacyClaudeHome, sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { searchTextForTranscript } from "@/lib/scanner/describe";
import { semanticTitle } from "@/lib/title";

import { agentRegistry, type AgentRegistry } from "./registry";
import type { IdentityWaveMigrationResult, IdentityWaveSeat } from "./identityWaveMigration";

export function titleFromTranscriptHead(pathname: string, engine: "claude" | "codex"): string | null {
  try {
    const stat = fs.statSync(pathname);
    if (!stat.isFile()) return null;
    const text = searchTextForTranscript(pathname, stat.size, engine);
    return semanticTitle(text.title) ?? semanticTitle(text.firstPrompt);
  } catch {
    return null;
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
  } catch {
    return null;
  }
}

export interface IdentityWaveStartupDependencies {
  registry: Pick<AgentRegistry, "runIdentityWaveMigration">;
  seats(): readonly IdentityWaveSeat[];
  now(): string;
  transcriptTitle(pathname: string, engine: "claude" | "codex"): string | null;
  sharedPath(pathname: string): string | null;
  log(message: string, detail: Record<string, unknown>): void;
  env: Readonly<Record<string, string | undefined>>;
}

export function runIdentityWaveMigrationAtStartup(
  overrides: Partial<IdentityWaveStartupDependencies> = {},
): IdentityWaveMigrationResult {
  const dependencies: IdentityWaveStartupDependencies = {
    registry: overrides.registry ?? agentRegistry(),
    seats: overrides.seats ?? activeOrchestratorSeats,
    now: overrides.now ?? (() => new Date().toISOString()),
    transcriptTitle: overrides.transcriptTitle ?? titleFromTranscriptHead,
    sharedPath: overrides.sharedPath ?? sharedPathForLegacyClaudeTranscript,
    log: overrides.log ?? ((message, detail) => console.info(message, detail)),
    env: overrides.env ?? process.env,
  };
  const result = dependencies.registry.runIdentityWaveMigration({
    dryRun: dependencies.env.LLV_IDENTITY_WAVE_DRY_RUN === "1",
    now: dependencies.now(),
    transcriptTitle: dependencies.transcriptTitle,
    sharedPathForLegacy: dependencies.sharedPath,
    orchestratorSeats: dependencies.seats(),
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
