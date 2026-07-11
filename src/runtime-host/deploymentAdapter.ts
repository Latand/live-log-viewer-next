import type { ViewerHealthEvidence, ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import type { ViewerDeploymentAdapter } from "./deployment";

type CommandRunner = (action: string, input: Record<string, unknown>) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment adapter returned invalid JSON");
  return value as Record<string, unknown>;
}

function release(value: unknown): ViewerReleaseIdentity {
  const item = object(value);
  if (typeof item.image !== "string" || typeof item.container !== "string" || typeof item.endpoint !== "string" || typeof item.revision !== "string") {
    throw new Error("deployment adapter returned an invalid release identity");
  }
  return { image: item.image, container: item.container, endpoint: item.endpoint, revision: item.revision };
}

function evidence(value: unknown): ViewerHealthEvidence {
  const item = object(value);
  const assets = Array.isArray(item.assets) ? item.assets.map((asset) => object(asset)) : [];
  if (
    typeof item.checkedAt !== "string"
    || typeof item.endpoint !== "string"
    || typeof item.processReady !== "boolean"
    || typeof item.rootStatus !== "number"
    || (item.authenticatedStatus !== null && typeof item.authenticatedStatus !== "number")
    || typeof item.ok !== "boolean"
    || assets.some((asset) => typeof asset.path !== "string" || typeof asset.status !== "number")
  ) throw new Error("deployment adapter returned invalid health evidence");
  return {
    checkedAt: item.checkedAt,
    endpoint: item.endpoint,
    processReady: item.processReady,
    rootStatus: item.rootStatus,
    authenticatedStatus: item.authenticatedStatus,
    assets: assets.map((asset) => ({ path: asset.path as string, status: asset.status as number })),
    ok: item.ok,
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
  };
}

/**
 * Host-owned adapter protocol. The executable path comes from runtime-host
 * configuration. Request data is sent as one JSON document on stdin; it never
 * selects a command, executable, shell fragment, or Docker argument.
 */
export class HostCommandViewerDeploymentAdapter implements ViewerDeploymentAdapter {
  constructor(private readonly run: CommandRunner) {}

  static fromExecutable(executable: string): HostCommandViewerDeploymentAdapter {
    if (!executable.startsWith("/")) throw new Error("viewer deployment adapter path must be absolute");
    return new HostCommandViewerDeploymentAdapter(async (action, input) => {
      const child = Bun.spawn([executable, action], {
        stdin: new Blob([JSON.stringify(input)]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1" },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error((stderr.trim() || `deployment adapter ${action} failed`).slice(0, 500));
      try { return JSON.parse(stdout) as unknown; }
      catch { throw new Error(`deployment adapter ${action} returned invalid JSON`); }
    });
  }

  async resolveRevision(revision: string): Promise<string> {
    const result = object(await this.run("resolve-revision", { revision }));
    if (typeof result.revision !== "string") throw new Error("deployment adapter did not resolve a revision");
    return result.revision;
  }

  async buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
    return release(await this.run("build-candidate", { deploymentId, revision }));
  }

  async startCandidate(candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("start-candidate", { candidate });
  }

  async currentRelease(): Promise<ViewerReleaseIdentity | null> {
    const result = await this.run("current-release", {});
    return result === null ? null : release(result);
  }

  async verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> {
    return evidence(await this.run("verify-candidate", { candidate }));
  }

  async promote(candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("promote", { candidate });
  }

  async verifyPromoted(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> {
    return evidence(await this.run("verify-promoted", { candidate }));
  }

  async rollback(previous: ViewerReleaseIdentity, candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("rollback", { previous, candidate });
  }
}
