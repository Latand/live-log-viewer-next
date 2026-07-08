import fs from "node:fs";

import type { FileEntry } from "@/lib/types";

import type { Workflow } from "./types";

type Exists = (pathname: string) => boolean;

function workflowPaths(wf: Workflow): string[] {
  const paths: string[] = [];
  if (wf.srcPath) paths.push(wf.srcPath);
  if (wf.fixerPath) paths.push(wf.fixerPath);
  for (const run of wf.stageRuns) {
    if (run.agentPath) paths.push(run.agentPath);
  }
  return paths;
}

export function workflowHasScannedTranscript(wf: Workflow, files: readonly FileEntry[]): boolean {
  if (!files.length) return false;
  const scanned = new Set(files.map((file) => file.path));
  return workflowPaths(wf).some((pathname) => scanned.has(pathname));
}

export function workflowWorkspaceExists(wf: Workflow, exists: Exists = fs.existsSync): boolean {
  return Boolean((wf.repoDir && exists(wf.repoDir)) || (wf.worktreeDir && exists(wf.worktreeDir)));
}

export function workflowVisibleInFileScan(wf: Workflow, files: readonly FileEntry[], exists: Exists = fs.existsSync): boolean {
  return workflowWorkspaceExists(wf, exists) || workflowHasScannedTranscript(wf, files);
}

export function filterWorkflowsForFileScan(
  workflows: readonly Workflow[],
  files: readonly FileEntry[],
  exists: Exists = fs.existsSync,
): Workflow[] {
  return workflows.filter((wf) => workflowVisibleInFileScan(wf, files, exists));
}
