// Verbatim capability/readiness consumers from src/runtime-host/deploymentHealth.ts
// at bdf4b85658802c2e1765382c5aef04a6585980a7. Keep independent of successor code.
export function hasViewerDeploymentCapability(status: number, body: string): boolean {
  if (status !== 200) return false;
  try {
    const response = JSON.parse(body) as { capability?: unknown; version?: unknown };
    return response?.capability === "viewer-deployments" && response.version === 1;
  } catch {
    return false;
  }
}

/** Older release capabilities omit this field and already represent complete
 * startup. SQLite-wave releases expose an explicit false value until their
 * post-activation serving controllers have started. */
export function viewerDeploymentReleaseReady(status: number, body: string): boolean {
  if (!hasViewerDeploymentCapability(status, body)) return false;
  try {
    return (JSON.parse(body) as { releaseReady?: unknown }).releaseReady !== false;
  } catch {
    return false;
  }
}
