import { createHash } from "node:crypto";
import path from "node:path";

function artifactKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function viewerCandidateContainerName(deploymentId: string): string {
  return `llv-deploy-${artifactKey(deploymentId)}`;
}

export function viewerCandidateImageName(revision: string, container: string): string {
  return `agent-log-viewer:deploy-${revision}-${artifactKey(container)}`;
}

export function viewerComposeSnapshotName(container: string): string {
  return `${artifactKey(container)}.json`;
}

/** Where that snapshot lives under a state directory. One definition, because
    the runtime host writes it and the MCP control client reads the Viewer
    credential back out of it (#1511). */
export function viewerComposeSnapshotPath(stateDir: string, container: string): string {
  return path.join(stateDir, "deployments", "compose", viewerComposeSnapshotName(container));
}
