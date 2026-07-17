import fs from "node:fs";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import type { FileEntry, RootKey } from "@/lib/types";

import { catalogEntryToFileEntry, conversationCatalogSnapshot } from "./conversationCatalog";
import { describe } from "./describe";
import { scanRootEntries } from "./roots";

function containingRoot(pathname: string): [RootKey, string] | null {
  let real: string;
  try {
    real = fs.realpathSync(pathname);
  } catch {
    return null;
  }
  for (const [rootName, root] of scanRootEntries()) {
    if (rootName === "claude-tasks") continue;
    try {
      const rootReal = fs.realpathSync(root);
      if (real.startsWith(rootReal + path.sep)) return [rootName, root];
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolves one exact conversation without traversing every account history.
 * Flow actions run on a card the operator already selected, so a catalog hit
 * is the common path. The direct metadata read covers a transcript created
 * after the latest catalog publication.
 */
export function conversationEntryForPath(pathname: string): FileEntry | null {
  if (!path.isAbsolute(pathname)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(pathname);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const catalog = conversationCatalogSnapshot().find((entry) => entry.path === pathname);
  const base = catalog ? catalogEntryToFileEntry(catalog) : null;
  const root = containingRoot(pathname);
  if (!root) return null;
  const [rootName, rootPath] = root;
  const metadata = base ? null : describe(rootName, rootPath, pathname, st);
  const registryConversation = agentRegistry().conversationForPath(pathname);

  return {
    ...(base ?? {
      path: pathname,
      root: rootName,
      name: path.relative(rootPath, pathname),
      project: metadata!.project,
      worktree: metadata!.worktree,
      cwd: metadata!.cwd,
      sessionStartedAt: metadata!.sessionStartedAt,
      nativeParentThreadId: metadata!.nativeParentThreadId,
      projectRoot: metadata!.projectRoot,
      title: metadata!.title,
      engine: metadata!.engine,
      kind: metadata!.kind,
      fmt: metadata!.fmt,
      parent: null,
      mtime: st.mtimeMs / 1_000,
      size: st.size,
      activity: "idle" as const,
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    }),
    mtime: st.mtimeMs / 1_000,
    size: st.size,
    ...(registryConversation ? { conversationId: registryConversation.id } : {}),
  };
}
