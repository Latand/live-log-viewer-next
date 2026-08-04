/**
 * One-time cutover to the shared Claude transcript store (issue #891 phase 1).
 *
 * Merges every Claude transcript root (legacy home, live managed accounts,
 * retained retired-account archives) into the viewer-owned shared root and
 * replaces each source `projects` directory with a symlink to it. Absolute
 * transcript paths inside the durable state files are rewritten to the
 * canonical shared prefix so registry/board/continuity identities keep
 * matching what the scanner emits afterwards.
 *
 * Dry-run by default — prints the full plan and exits. `--execute` performs
 * the cutover. Execution refuses to proceed while viewer containers are
 * running (state files are rewritten) unless `--allow-live` is passed.
 * Old paths keep resolving through the symlinks, so nothing that recorded a
 * pre-cutover absolute path breaks even if it is missed by the rewrite.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { legacyClaudeHome, claudeAccountsRoot, sharedClaudeProjectsRoot } from "../src/lib/accounts/claude";
import { stateDir } from "../src/lib/configDir";

const EXECUTE = process.argv.includes("--execute");
const ALLOW_LIVE = process.argv.includes("--allow-live");

export function transcriptRoots(): string[] {
  const roots: string[] = [];
  const legacy = path.join(legacyClaudeHome(), "projects");
  if (fs.existsSync(legacy)) roots.push(legacy);
  const accounts = claudeAccountsRoot();
  if (fs.existsSync(accounts)) {
    for (const entry of fs.readdirSync(accounts)) {
      const candidate = path.join(accounts, entry, "projects");
      if (fs.existsSync(candidate)) roots.push(candidate);
    }
  }
  return roots.filter((root) => {
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink();
  });
}

type Plan = { root: string; files: number; bytes: number };

export function scanRoot(root: string, seen: Map<string, string>): { plan: Plan; collisions: string[] } {
  let files = 0; let bytes = 0; const collisions: string[] = [];
  for (const project of fs.readdirSync(root)) {
    const projectDir = path.join(root, project);
    if (!fs.lstatSync(projectDir).isDirectory()) continue;
    for (const file of fs.readdirSync(projectDir)) {
      const relative = path.join(project, file);
      const holder = seen.get(relative);
      if (holder) collisions.push(`${relative}: ${holder} vs ${root}`);
      else seen.set(relative, root);
      files += 1;
      try { bytes += fs.statSync(path.join(projectDir, file)).size; } catch { /* raced away */ }
    }
  }
  return { plan: { root, files, bytes }, collisions };
}

function llvContainersRunning(): string[] {
  try {
    return execSync("docker ps --format {{.Names}}", { encoding: "utf8" })
      .split("\n").filter((name) => name.startsWith("llv-"));
  } catch { return []; }
}

export function mergeRoot(root: string, shared: string): void {
  for (const project of fs.readdirSync(root)) {
    const source = path.join(root, project);
    if (!fs.lstatSync(source).isDirectory()) continue;
    const target = path.join(shared, project);
    if (!fs.existsSync(target)) { fs.renameSync(source, target); continue; }
    for (const file of fs.readdirSync(source)) {
      const destination = path.join(target, file);
      if (fs.existsSync(destination)) throw new Error(`collision surfaced during merge: ${project}/${file}`);
      fs.renameSync(path.join(source, file), destination);
    }
    fs.rmdirSync(source);
  }
  // Stray top-level files (none expected) stay behind in the retired dir.
  const leftovers = fs.readdirSync(root);
  const retired = `${root}.pre-shared-store`;
  fs.renameSync(root, retired);
  if (leftovers.length === 0) fs.rmdirSync(retired);
  fs.symlinkSync(shared, root);
}

export function rewriteStateFiles(roots: string[], shared: string, write: boolean): Array<{ file: string; replaced: number }> {
  const results: Array<{ file: string; replaced: number }> = [];
  const state = stateDir();
  if (!fs.existsSync(state)) return results;
  for (const entry of fs.readdirSync(state)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(state, entry);
    if (!fs.lstatSync(file).isFile()) continue;
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let replaced = 0;
    for (const root of roots) {
      const needle = root + path.sep;
      const replacement = shared + path.sep;
      const parts = text.split(needle);
      replaced += parts.length - 1;
      text = parts.join(replacement);
    }
    if (replaced > 0) {
      if (write) {
        const temporary = `${file}.cutover.tmp`;
        fs.writeFileSync(temporary, text, { mode: 0o600 });
        fs.renameSync(temporary, file);
      }
      results.push({ file, replaced });
    }
  }
  return results;
}

function main(): void {
  const shared = sharedClaudeProjectsRoot();
  const roots = transcriptRoots().filter((root) => {
    try { return fs.realpathSync(root) !== fs.realpathSync(shared); } catch { return true; }
  });
  if (roots.length === 0) { console.log("nothing to cut over — every root already points at the shared store"); return; }

  const seen = new Map<string, string>();
  const plans: Plan[] = []; const collisions: string[] = [];
  for (const root of roots) {
    const { plan, collisions: found } = scanRoot(root, seen);
    plans.push(plan); collisions.push(...found);
  }
  console.log(`shared root: ${shared}`);
  for (const plan of plans) console.log(`  ${plan.root}: ${plan.files} files, ${(plan.bytes / 1e6).toFixed(1)} MB`);
  if (collisions.length > 0) {
    console.error(`\nABORT: ${collisions.length} collision(s):`);
    for (const line of collisions) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log("collisions: 0");

  const rewrites = rewriteStateFiles(roots, shared, false);
  for (const { file, replaced } of rewrites) console.log(`  state rewrite: ${path.basename(file)} — ${replaced} path(s)`);

  if (!EXECUTE) { console.log("\ndry-run only — pass --execute to perform the cutover"); return; }

  const running = llvContainersRunning();
  if (running.length > 0 && !ALLOW_LIVE) {
    console.error(`ABORT: viewer containers running (${running.join(", ")}); stop them or pass --allow-live`);
    process.exitCode = 1;
    return;
  }

  const backup = path.join(path.dirname(stateDir()), `state-backup-cutover-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(stateDir())) {
    if (entry.endsWith(".json")) {
      try { fs.copyFileSync(path.join(stateDir(), entry), path.join(backup, entry)); } catch { /* transient lock artifacts */ }
    }
  }
  console.log(`state backup: ${backup}`);

  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  fs.chmodSync(shared, 0o700);
  for (const root of roots) { mergeRoot(root, shared); console.log(`merged + symlinked: ${root}`); }
  rewriteStateFiles(roots, shared, true);
  console.log("cutover complete");
}

if (import.meta.main) main();
