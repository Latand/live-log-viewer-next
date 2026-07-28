import { runtimeHostClient } from "./client";
import type { ViewerDeploymentReceipt, ViewerDeploymentRequest } from "./contracts";

/**
 * Asking the runtime host to deploy.
 *
 * Lives beside the route rather than inside it because a `route.ts` may export only
 * the documented route fields — handlers and segment config — and Next.js enforces
 * that at build time. Anything the route shares with a test belongs in a module both
 * import, which is the shape `scanCache` and `orchestrator/retire` already use.
 *
 * Seamed so the deployment endpoint's authorization contract is testable without a
 * runtime host socket, and — more to the point — so a test can assert that a refused
 * deploy never reaches this function at all.
 */

export type DeploymentRuntime = (request: ViewerDeploymentRequest) => Promise<ViewerDeploymentReceipt>;

export class DeploymentRuntimeUnavailableError extends Error {
  constructor() {
    super("runtime host socket is unavailable");
    this.name = "DeploymentRuntimeUnavailableError";
  }
}

const productionRuntime: DeploymentRuntime = (request) => {
  const client = runtimeHostClient();
  if (!client) throw new DeploymentRuntimeUnavailableError();
  return client.requestViewerDeployment(request);
};

let deploymentRuntime: DeploymentRuntime = productionRuntime;

export function requestViewerDeployment(request: ViewerDeploymentRequest): Promise<ViewerDeploymentReceipt> {
  return deploymentRuntime(request);
}

/** Tests only; `null` restores the production path. */
export function setDeploymentRuntimeForTests(runtime: DeploymentRuntime | null): void {
  deploymentRuntime = runtime ?? productionRuntime;
}
