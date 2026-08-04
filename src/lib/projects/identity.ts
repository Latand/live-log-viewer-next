import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepositoryProjectIdentity {
  project: string;
  displayName: string;
  canonicalRemote: string;
}

export const UNRESOLVED_PROJECT = "project_unresolved";
export const UNRESOLVED_PROJECT_NAME = "Unresolved project";

export interface DirectoryProjectIdentity {
  project: string;
  displayName: string;
}

/** Both durable project id shapes the resolver mints: repository identities
    and directory identities. Everything else is an operator alias slug. */
export function isCanonicalProjectId(project: string): boolean {
  return /^(?:repo|dir)-[0-9a-f]{32}$/.test(project);
}

/** Stable identity for a cwd with no repository (operator decision,
    2026-08-04): the directory itself is the project, so sessions in plain
    folders group by folder instead of pooling in "Unresolved project". The
    home directory gets a `home-` prefixed name — bare "latand" would read
    like a repository. */
export function projectIdentityFromDirectory(cwd: string): DirectoryProjectIdentity | null {
  const resolved = (() => {
    try { return fs.realpathSync.native(cwd); } catch { return path.resolve(cwd); }
  })();
  const base = path.basename(resolved);
  if (!base || resolved === path.sep) return null;
  const displayName = resolved === os.homedir() ? `home-${base}` : base;
  const digest = crypto.createHash("sha256").update(`dir:${resolved}`).digest("hex").slice(0, 32);
  return { project: `dir-${digest}`, displayName };
}

export function displayNameFromProjectIdentity(project: string): string {
  if (project === UNRESOLVED_PROJECT) return UNRESOLVED_PROJECT_NAME;
  return project;
}

/* Every real git directory carries HEAD; tooling sometimes plants a vestigial
   `.git/` holding only auxiliary files (a bare `info/exclude` in the operator's
   home directory swallowed 1000+ conversations into "Unresolved project").
   Git itself refuses such a directory, so the identity walk must too — an
   unvalidated marker turns the whole subtree into a phantom repository root. */
function looksLikeGitDirectory(directory: string): boolean {
  try { return fs.statSync(path.join(directory, "HEAD")).isFile(); }
  catch { return false; }
}

function gitDirectory(root: string): string | null {
  const marker = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isDirectory()) return looksLikeGitDirectory(marker) ? marker : null;
    if (!stat.isFile()) return null;
    const pointer = fs.readFileSync(marker, "utf8").slice(0, 4096);
    const target = /^gitdir:\s*(.+?)\s*$/im.exec(pointer)?.[1];
    if (!target) return null;
    const resolved = path.resolve(root, target);
    return looksLikeGitDirectory(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function repositoryRootForPath(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    if (gitDirectory(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function commonGitDirectory(directory: string): string {
  try {
    const common = fs.readFileSync(path.join(directory, "commondir"), "utf8").trim();
    return common ? path.resolve(directory, common) : directory;
  } catch {
    return directory;
  }
}

function originRemote(config: string): string | null {
  let origin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/i.exec(line);
    if (section) {
      origin = section[1] === "origin";
      continue;
    }
    if (/^\s*\[/.test(line)) {
      origin = false;
      continue;
    }
    if (!origin) continue;
    const value = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    const remote = value?.replace(/\s+[;#].*$/, "").trim();
    if (remote) return remote;
  }
  return null;
}

function canonicalRemote(remote: string, root: string): string | null {
  /* A remote with an explicit scheme must never reach the scp-like matcher:
     `https://host/team/repo` would otherwise parse as host `https`, minting a
     second identity for a repository that ssh clones resolve correctly. */
  const scp = /^[a-z][a-z0-9+.-]*:\/\//i.test(remote)
    ? null
    : /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    const pathname = scp[2]!.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return pathname ? `${host}/${pathname}` : null;
  }
  try {
    const url = new URL(remote);
    if (url.protocol === "file:") {
      const pathname = path.resolve(url.pathname).replace(/\.git$/i, "");
      return `file:${pathname}`;
    }
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return host && pathname ? `${host}${port}/${pathname}` : null;
  } catch {
    const pathname = path.resolve(root, remote).replace(/\.git$/i, "");
    return `file:${pathname}`;
  }
}

function remoteDisplayName(remote: string): string | null {
  const name = remote.replace(/^file:/, "").split("/").filter(Boolean).at(-1)?.trim();
  return name || null;
}

export function projectIdentityFromRepositoryRoot(root: string): RepositoryProjectIdentity | null {
  const directory = gitDirectory(root);
  if (!directory) return null;
  let config: string;
  try {
    config = fs.readFileSync(path.join(commonGitDirectory(directory), "config"), "utf8");
  } catch {
    return null;
  }
  const remote = originRemote(config);
  const localRoot = (() => {
    try {
      return fs.realpathSync.native(root);
    } catch {
      return path.resolve(root);
    }
  })();
  const canonical = remote ? canonicalRemote(remote, root) : `local:${localRoot}`;
  const displayName = canonical ? remoteDisplayName(canonical) : null;
  if (!canonical || !displayName) return null;
  const digest = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return {
    project: `repo-${digest}`,
    displayName,
    canonicalRemote: canonical,
  };
}
