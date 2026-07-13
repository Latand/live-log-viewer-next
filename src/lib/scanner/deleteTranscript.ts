import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { claudeProjectRootFor, scanRootEntries } from "./roots";

function companionDir(filePath: string): string | null {
  const root = claudeProjectRootFor(filePath);
  if (!root) return null;
  const rel = path.relative(root, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || !filePath.endsWith(".jsonl")) return null;
  return filePath.slice(0, -".jsonl".length);
}

async function pruneEmptyDirs(filePath: string): Promise<void> {
  const root = scanRootEntries().map(([, candidate]) => candidate).find((candidate) => filePath.startsWith(candidate + path.sep));
  if (!root) return;
  let dir = path.dirname(filePath);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

async function removeCompanionAndPrune(target: string): Promise<void> {
  const dir = companionDir(target);
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await pruneEmptyDirs(target);
}

export async function removeTranscriptFromDisk(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await removeCompanionAndPrune(target);
}

export async function removeProjectTranscriptsFromDisk(targets: readonly string[]): Promise<void> {
  const staged: Array<{ target: string; staged: string }> = [];
  const deepestFirst = [...targets].sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
  try {
    for (const target of deepestFirst) {
      const stagedPath = `${target}.llv-delete-${crypto.randomUUID()}`;
      await fs.rename(target, stagedPath);
      staged.push({ target, staged: stagedPath });
    }
  } catch (error) {
    for (const item of staged.reverse()) await fs.rename(item.staged, item.target).catch(() => undefined);
    throw error;
  }
  for (const item of staged) {
    await fs.rm(item.staged, { force: true }).catch(() => undefined);
    await removeCompanionAndPrune(item.target);
  }
}
