import fs from "node:fs";

import {
  canonicalRevisionQuery,
  isExactRevision,
  REQUESTED_REVISION_REFUSAL,
  revisionNotFoundMessage,
} from "@/lib/runtime/canonicalRevision";

export interface CanonicalMirrorOptions {
  deploymentDir: string;
  mirrorDir: string;
  remote: string;
}

export interface CanonicalMirrorDependencies {
  run(argv: string[]): Promise<string>;
}

async function isValidBareMirror(directory: string, run: CanonicalMirrorDependencies["run"]): Promise<boolean> {
  try {
    return (await run(["git", "--git-dir", directory, "rev-parse", "--is-bare-repository"])).trim() === "true";
  } catch {
    return false;
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function ensureCanonicalMirror(
  options: CanonicalMirrorOptions,
  dependencies: CanonicalMirrorDependencies,
): Promise<void> {
  fs.mkdirSync(options.deploymentDir, { recursive: true, mode: 0o700 });
  const incomingDir = `${options.mirrorDir}.incoming`;
  if (!await isValidBareMirror(options.mirrorDir, dependencies.run)) {
    fs.rmSync(options.mirrorDir, { recursive: true, force: true });
    fs.rmSync(incomingDir, { recursive: true, force: true });
    await dependencies.run(["git", "clone", "--mirror", options.remote, incomingDir]);
    if (!await isValidBareMirror(incomingDir, dependencies.run)) throw new Error("canonical mirror clone is invalid");
    fs.renameSync(incomingDir, options.mirrorDir);
    syncDirectory(options.deploymentDir);
  } else {
    fs.rmSync(incomingDir, { recursive: true, force: true });
  }
  await dependencies.run(["git", "--git-dir", options.mirrorDir, "remote", "set-url", "origin", options.remote]);
  await dependencies.run(["git", "--git-dir", options.mirrorDir, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"]);
}

/**
 * Resolves a requested deploy revision to the immutable commit it names, in the
 * canonical mirror (#1033). A branch ref resolves to the tip the canonical
 * repository holds right now; an explicit SHA resolves to itself when the
 * mirror actually carries that object — `rev-parse --verify <40-hex>` alone
 * echoes any well-formed hex string back, which is why the `^{commit}` peel is
 * the check that matters.
 */
export async function resolveCanonicalRevision(
  requested: string,
  options: Pick<CanonicalMirrorOptions, "mirrorDir" | "remote">,
  dependencies: CanonicalMirrorDependencies & { ensureMirror(): Promise<void> },
): Promise<string> {
  const query = canonicalRevisionQuery(requested);
  if (!query) throw new Error(REQUESTED_REVISION_REFUSAL);
  await dependencies.ensureMirror();
  let revision: string;
  try {
    revision = await dependencies.run(["git", "--git-dir", options.mirrorDir, "rev-parse", "--verify", query]);
  } catch {
    throw new Error(revisionNotFoundMessage(requested, options.remote));
  }
  if (!isExactRevision(revision)) throw new Error("canonical repository returned an invalid revision");
  return revision;
}
