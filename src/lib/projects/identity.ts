import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RepositoryProjectIdentity {
  project: string;
  displayName: string;
  canonicalRemote: string;
}

export const UNRESOLVED_PROJECT = "project_unresolved";
export const UNRESOLVED_PROJECT_NAME = "Unresolved project";

export function displayNameFromProjectIdentity(project: string): string {
  if (project === UNRESOLVED_PROJECT) return UNRESOLVED_PROJECT_NAME;
  return project;
}

function gitDirectory(root: string): string | null {
  const marker = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isDirectory()) return marker;
    if (!stat.isFile()) return null;
    const pointer = fs.readFileSync(marker, "utf8").slice(0, 4096);
    const target = /^gitdir:\s*(.+?)\s*$/im.exec(pointer)?.[1];
    return target ? path.resolve(root, target) : null;
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
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
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
  if (!remote) return null;
  const canonical = canonicalRemote(remote, root);
  const displayName = canonical ? remoteDisplayName(canonical) : null;
  if (!canonical || !displayName) return null;
  const digest = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return {
    project: `repo-${digest}`,
    displayName,
    canonicalRemote: canonical,
  };
}
