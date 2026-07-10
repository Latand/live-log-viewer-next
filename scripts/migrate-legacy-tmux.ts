import fs from "node:fs";
import path from "node:path";

import { createLegacyMigration, type LegacyMigration } from "@/lib/agent/migration";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function migrationPath(id: string): string { return statePath("migrations", `legacy-tmux-${id}.json`); }
function writeMigration(migration: LegacyMigration): void {
  const filename = migrationPath(migration.id);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, JSON.stringify(migration, null, 2) + "\n", { mode: 0o600 });
}

const command = process.argv[2];
if (command !== "preflight") {
  console.error("only `preflight --root <transcript>` is available in this implementation build");
  console.error("cutover remains gated for the later explicit operator-approved runbook");
  process.exitCode = 2;
} else {
  const rootPath = arg("--root");
  const engine = rootPath?.includes("/.codex/") ? "codex" : rootPath?.includes("/.claude/") ? "claude" : null;
  const key = rootPath && engine ? sessionKeyFromTranscript(engine, rootPath) : null;
  if (!rootPath || !key || !fs.existsSync(rootPath)) {
    console.error("preflight requires an existing Codex or Claude root transcript path");
    process.exitCode = 2;
  } else {
    const migration = createLegacyMigration(key, rootPath);
    writeMigration(migration);
    console.log(JSON.stringify({ migration: migration.id, phase: migration.phase, approvalToken: migration.approvalToken, root: migration.root, rootPath }, null, 2));
    console.log("SAFE PREFLIGHT COMPLETE: this command sent no message, started no tmux server, and changed no service.");
  }
}
