import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** App dir that matches the npm package name; new installs land here. */
const APP_DIR = "agent-log-viewer";
/** Former app dir, still honored as a fallback so existing setups keep working. */
const LEGACY_APP_DIR = "live-log-viewer";

function configRoot(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

/**
 * Resolve a config file under the app dir at call time: the agent-log-viewer
 * copy wins, and the legacy live-log-viewer copy is returned only when it is
 * the one that exists. Callers read the returned path and treat a missing file
 * as "no override", so falling through to the (possibly absent) new path is safe.
 */
export function configFilePath(name: string): string {
  return resolveWithFallback(configRoot(), name);
}

/**
 * Resolve a cache entry (file or dir) under the app dir with the same
 * agent-log-viewer-first, legacy-fallback logic as {@link configFilePath}.
 */
export function cacheEntryPath(name: string): string {
  return resolveWithFallback(cacheRoot(), name);
}

function resolveWithFallback(root: string, name: string): string {
  const preferred = path.join(root, APP_DIR, name);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(root, LEGACY_APP_DIR, name);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

/* Viewer-owned mutable state used to live under ~/.claude/viewer-state and
   ~/.claude/viewer-inbox — inside another tool's directory. It now lives in
   the app's own config dir; the first access copies the legacy content over,
   so flows, workflows, tasks, push subscriptions and inbox images survive
   the move. The legacy dirs are left in place untouched. */
const migrated = new Set<string>();

/* Completion marker inside the target dir. A bare "target exists" check
   cannot distinguish a finished migration from a dir that fresh state writes
   created after an interrupted one — only the sentinel says the legacy
   content actually arrived. */
const MIGRATED_SENTINEL = ".migrated-from-legacy";

/**
 * Copy-once move of a legacy dir into its new home; exported for tests.
 *
 * The copy lands in a temp sibling first and reaches the target through an
 * atomic rename, so a crash mid-copy leaves no half-filled target. A target
 * that exists without the sentinel (state writes raced an earlier failed
 * attempt) heals by copying the legacy entries it is missing, never
 * overwriting newer files. Failures are logged and stay un-memoized, so the
 * next call retries instead of silently accepting an empty state dir.
 */
export function migrateLegacyDir(target: string, legacy: string): void {
  if (process.env.LLV_RESOURCE_OBSERVATION_WORKER === "1") return;
  if (migrated.has(target)) return;
  const sentinel = path.join(target, MIGRATED_SENTINEL);
  const stamp = () => `${new Date().toISOString()} ${legacy}\n`;
  try {
    if (fs.existsSync(sentinel)) {
      migrated.add(target);
      return;
    }
    if (!fs.existsSync(legacy)) {
      /* Nothing to migrate: mark that decision too, so a legacy dir that
         appears later (a rollback, a restored backup) never clobbers state
         accumulated here in the meantime. */
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(sentinel, stamp());
      migrated.add(target);
      return;
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.migrating.${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      try {
        fs.cpSync(legacy, tmp, { recursive: true });
        fs.writeFileSync(path.join(tmp, MIGRATED_SENTINEL), stamp());
        fs.renameSync(tmp, target);
      } catch (error) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw error;
      }
      migrated.add(target);
      return;
    }
    /* Partial target from a pre-sentinel run: fill in whatever legacy
       entries are missing, keep everything already written here. */
    fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    fs.writeFileSync(sentinel, stamp());
    migrated.add(target);
  } catch (error) {
    console.error(`viewer state migration ${legacy} -> ${target} failed; will retry:`, error);
  }
}

/**
 * Root of the viewer's mutable state (flows, workflows, tasks, lineage,
 * events, push keys, limits cache). LLV_STATE_DIR overrides it wholesale —
 * tests and sandboxed runs point it at a scratch dir.
 */
export function stateDir(): string {
  const override = process.env.LLV_STATE_DIR;
  if (override) return override;
  const dir = path.join(configRoot(), APP_DIR, "state");
  migrateLegacyDir(dir, path.join(os.homedir(), ".claude", "viewer-state"));
  return dir;
}

/** A file or subdirectory inside the viewer state dir. */
export function statePath(...segments: string[]): string {
  return path.join(stateDir(), ...segments);
}

/** Composer-pasted images the agents receive as file paths. */
export function inboxDir(): string {
  const dir = path.join(configRoot(), APP_DIR, "inbox");
  migrateLegacyDir(dir, path.join(os.homedir(), ".claude", "viewer-inbox"));
  return dir;
}
