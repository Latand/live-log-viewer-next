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

/**
 * Allocate one capture-owned directory. An explicit override names the parent
 * for unique run directories and must itself be a script-labelled child of the
 * system temp directory. The returned directory is fresh, so callers never
 * need to clear an environment-supplied path.
 */
export function createCaptureDirectory(options: CaptureDirectoryOptions): string {
  const tempRoot = fs.realpathSync(os.tmpdir());
  let parent = tempRoot;

  if (options.raw !== undefined) {
    const requested = path.resolve(options.raw);
    let resolved: string;
    try {
      resolved = fs.realpathSync(requested);
    } catch {
      throw new Error(`${options.envName} refused ${requested}: override must name an existing directory`);
    }

    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`${options.envName} refused ${requested}: override must name a directory`);
    }

    const home = fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : path.resolve(os.homedir());
    const repo = fs.realpathSync(options.repoRoot);
    const protectedPaths = [path.parse(resolved).root, home, repo];
    const reason = !isWithin(resolved, tempRoot)
      ? `override must be a descendant of ${tempRoot}`
      : !path.basename(resolved).startsWith(options.prefix)
        ? `override leaf must start with ${options.prefix}`
        : protectedPaths.some((protectedPath) => overlaps(resolved, protectedPath))
          ? "override overlaps a protected filesystem location"
          : null;

    if (reason) {
      throw new Error(`${options.envName} refused ${requested} (resolved to ${resolved}): ${reason}`);
    }
    parent = resolved;
  }

  return fs.mkdtempSync(path.join(parent, `${options.prefix}-`));
}
