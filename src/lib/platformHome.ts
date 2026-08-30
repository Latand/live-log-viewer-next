import os from "node:os";
import path from "node:path";

/**
 * The home directory the Viewer reads transcripts, config and state under.
 *
 * On POSIX this is `$HOME` first and `os.homedir()` only as a fallback, which
 * is deliberate and load-bearing: Bun's `os.homedir()` ignores an env override,
 * so the isolated demo, evidence and test runtimes — which repoint `HOME` and
 * nothing else — would otherwise read the machine's real home.
 *
 * On Windows `HOME` is ignored. It is not a Windows variable; the shells that
 * set it there (Git Bash, MSYS) set it to a POSIX-shaped value such as
 * `/c/Users/<name>`, which `path.resolve` turns into a path on the current
 * drive that names nothing. `USERPROFILE` is the variable Windows itself sets
 * and the one `os.homedir()` consults, so it keeps the same override property
 * the POSIX branch has — but only when it actually looks like a Windows
 * absolute path, so a shell that exports a POSIX value into it is refused too.
 */
export function homeDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  fallback: () => string = os.homedir,
): string {
  /* The `platform` argument governs the path semantics too, so the Windows rule
     is assertable from a Linux runner and not only from the Windows leg. */
  if (platform === "win32") {
    const profile = env.USERPROFILE?.trim();
    return path.win32.resolve(profile && isWindowsAbsolute(profile) ? profile : fallback());
  }
  return path.posix.resolve(env.HOME?.trim() || fallback());
}

/** A drive-rooted (`C:\…`) or UNC (`\\server\share`) path. Pure. */
export function isWindowsAbsolute(pathname: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathname) || /^\\\\[^\\]/.test(pathname);
}
