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

function sameContent(left: string, right: string): boolean {
  try {
    const a = fs.statSync(left); const b = fs.statSync(right);
    if (a.size !== b.size) return false;
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch { return false; }
}

/* Same-name file collision policy across roots:
   - `.jsonl` transcripts carry session identity — never mergeable, hard abort.
   - identical content deduplicates silently.
   - MEMORY.md is a line index — the union of both sides is the merge.
   - anything else keeps the first arrival and preserves the other under a
     `.from-<root>` suffix, so nothing is ever lost. */
type Resolution = "abort" | "dedupe" | "union" | "suffix";

function resolutionFor(relative: string, existing: string, incoming: string): Resolution {
  if (relative.endsWith(".jsonl")) return "abort";
  if (sameContent(existing, incoming)) return "dedupe";
  if (path.basename(relative) === "MEMORY.md") return "union";
  return "suffix";
}

function walkFiles(root: string, visit: (absolute: string, relative: string) => void): void {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) stack.push(childRelative);
      else if (entry.isFile()) visit(path.join(root, childRelative), childRelative);
    }
  }
}

export function scanRoot(root: string, seen: Map<string, string>): { plan: Plan; collisions: string[]; merges: string[] } {
  let files = 0; let bytes = 0; const collisions: string[] = []; const merges: string[] = [];
  walkFiles(root, (absolute, relative) => {
    files += 1;
    try { bytes += fs.statSync(absolute).size; } catch { /* raced away */ }
    const holder = seen.get(relative);
    if (!holder) { seen.set(relative, absolute); return; }
    const resolution = resolutionFor(relative, holder, absolute);
    if (resolution === "abort") collisions.push(`${relative}: ${path.dirname(holder)} vs ${root}`);
    else merges.push(`${relative}: ${resolution} (${root})`);
  });
  return { plan: { root, files, bytes }, collisions, merges };
}

function suffixedName(filename: string, root: string): string {
  const extension = path.extname(filename);
  const label = path.basename(path.dirname(root)).replace(/[^a-zA-Z0-9-]+/g, "-") || "root";
  return `${filename.slice(0, filename.length - extension.length)}.from-${label}${extension}`;
}

function unionLines(target: string, source: string): void {
  const existing = fs.readFileSync(target, "utf8").split("\n");
  const known = new Set(existing.filter((line) => line.trim().length > 0));
  const additions = fs.readFileSync(source, "utf8").split("\n")
    .filter((line) => line.trim().length > 0 && !known.has(line));
  if (additions.length > 0) {
    const body = existing.join("\n").replace(/\n*$/, "\n") + additions.join("\n") + "\n";
    fs.writeFileSync(target, body, { mode: 0o600 });
  }
  fs.rmSync(source, { force: true });
}

function llvContainersRunning(): string[] {
  try {
    return execSync("docker ps --format {{.Names}}", { encoding: "utf8" })
      .split("\n").filter((name) => name.startsWith("llv-"));
  } catch { return []; }
}

function mergeTree(source: string, target: string, root: string): void {
  if (!fs.existsSync(target)) { fs.renameSync(source, target); return; }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) { mergeTree(from, to, root); continue; }
    if (!entry.isFile()) continue;
    if (!fs.existsSync(to)) { fs.renameSync(from, to); continue; }
    const resolution = resolutionFor(entry.name, to, from);
    if (resolution === "abort") throw new Error(`transcript collision surfaced during merge: ${to}`);
    if (resolution === "dedupe") { fs.rmSync(from, { force: true }); continue; }
    if (resolution === "union") { unionLines(to, from); continue; }
    fs.renameSync(from, path.join(target, suffixedName(entry.name, root)));
  }
  fs.rmdirSync(source);
}

export function mergeRoot(root: string, shared: string): void {
  for (const project of fs.readdirSync(root)) {
    const source = path.join(root, project);
    if (!fs.lstatSync(source).isDirectory()) continue;
    mergeTree(source, path.join(shared, project), root);
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
  const plans: Plan[] = []; const collisions: string[] = []; const merges: string[] = [];
  for (const root of roots) {
    const { plan, collisions: found, merges: resolvable } = scanRoot(root, seen);
    plans.push(plan); collisions.push(...found); merges.push(...resolvable);
  }
  console.log(`shared root: ${shared}`);
  for (const plan of plans) console.log(`  ${plan.root}: ${plan.files} files, ${(plan.bytes / 1e6).toFixed(1)} MB`);
  if (collisions.length > 0) {
    console.error(`\nABORT: ${collisions.length} transcript collision(s):`);
    for (const line of collisions) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log("transcript collisions: 0");
  if (merges.length > 0) {
    console.log(`resolvable same-name files: ${merges.length}`);
    for (const line of merges) console.log(`  ${line}`);
  }

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
