import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CaptureDirectoryOptions {
  envName: string;
  prefix: `llv-issue-${number}`;
  raw: string | undefined;
  repoRoot: string;
}

const isWithin = (candidate: string, parent: string): boolean =>
  candidate !== parent && candidate.startsWith(parent + path.sep);

const overlaps = (candidate: string, protectedPath: string): boolean =>
  candidate === protectedPath
  || candidate.startsWith(protectedPath + path.sep)
  || protectedPath.startsWith(candidate + path.sep);

function updateLatestLink(parent: string, prefix: string, runDirectory: string, envName: string): void {
  const latest = path.join(parent, `${prefix}-latest`);
  try {
    const existing = fs.lstatSync(latest);
    if (!existing.isSymbolicLink()) {
      throw new Error(`${envName} refused ${latest}: latest marker must be a symbolic link`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pending = path.join(parent, `.${prefix}-latest-${path.basename(runDirectory)}`);
  fs.symlinkSync(path.basename(runDirectory), pending, "dir");
  try {
    fs.renameSync(pending, latest);
  } catch (error) {
    fs.unlinkSync(pending);
    throw error;
  }
}

/**
 * Allocate one fresh capture-owned directory beneath a canonical temp parent
 * and atomically point the script's stable `-latest` symlink at that run.
 * Explicit overrides select the parent; callers never clear or overwrite it.
 */
export function createCaptureDirectory(options: CaptureDirectoryOptions): string {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const home = fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : path.resolve(os.homedir());
  const repo = fs.realpathSync(options.repoRoot);
  const protectedPaths = [home, repo];

  if (tempRoot === path.parse(tempRoot).root || protectedPaths.some((protectedPath) => overlaps(tempRoot, protectedPath))) {
    throw new Error(`TMPDIR refused ${tempRoot}: capture temp root overlaps a protected filesystem location`);
  }

  let parent = tempRoot;
  const raw = options.raw?.trim();
  if (raw) {
    const requested = path.resolve(raw);
    let resolved: string;
    try {
      resolved = fs.realpathSync(requested);
    } catch {
      throw new Error(`${options.envName} refused ${requested}: override must name an existing directory`);
    }

    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`${options.envName} refused ${requested}: override must name a directory`);
    }

    const reason = !isWithin(resolved, tempRoot)
      ? `override must be a descendant of ${tempRoot}`
      : !path.basename(resolved).startsWith(`${options.prefix}-`)
        ? `override leaf must start with ${options.prefix}-`
        : protectedPaths.some((protectedPath) => overlaps(resolved, protectedPath))
          ? "override overlaps a protected filesystem location"
          : null;
    if (reason) {
      throw new Error(`${options.envName} refused ${requested} (resolved to ${resolved}): ${reason}`);
    }
    parent = resolved;
  }

  const runDirectory = fs.mkdtempSync(path.join(parent, `${options.prefix}-`));
  try {
    updateLatestLink(parent, options.prefix, runDirectory, options.envName);
  } catch (error) {
    fs.rmdirSync(runDirectory);
    throw error;
  }
  return runDirectory;
}
