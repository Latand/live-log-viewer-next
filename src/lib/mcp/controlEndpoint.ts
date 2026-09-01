import fs from "node:fs";

const DEFAULT_VIEWER_CONTROL_URL = "http://127.0.0.1:8898";

type ControlEnvironment = Readonly<Record<string, string | undefined>>;

function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname)) return null;
    if (!endpoint.port) return null;
    return endpoint.origin;
  } catch {
    return null;
  }
}

function currentReleaseOrigin(env: ControlEnvironment): string | null {
  const targetPath = env.LLV_VIEWER_DEPLOY_TARGET?.trim();
  if (!targetPath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Viewer release target could not be read", { cause: error });
  }
  let target: Record<string, unknown>;
  try {
    target = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error("Viewer release target is invalid", { cause: error });
  }
  const endpoint = loopbackOrigin(target.endpoint);
  if (typeof target.image !== "string"
    || typeof target.container !== "string"
    || typeof target.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(target.revision)
    || !endpoint) throw new Error("Viewer release target is invalid");
  return endpoint;
}

function stableControlOrigin(env: ControlEnvironment): string {
  const configuredPort = env.LLV_VIEWER_PORT?.trim();
  if (!configuredPort) return DEFAULT_VIEWER_CONTROL_URL;
  if (!/^\d+$/.test(configuredPort)) throw new Error("LLV_VIEWER_PORT must be a valid TCP port");
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LLV_VIEWER_PORT must be a valid TCP port");
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Resolve the control origin for each tool call. Deployment health probes keep
 * their exact active-release endpoint. A durable client carrying an explicit
 * release target and stable port resolves an older launch URL through the
 * runtime host's stable listener (#1354).
 */
export function viewerControlOrigin(
  env: ControlEnvironment = process.env,
  pinConfiguredEndpoint = false,
): string {
  const configured = env.LLV_VIEWER_CONTROL_URL?.trim();
  if (!configured) return stableControlOrigin(env);
  /* Candidate health runs before promotion, while the durable release target
     still names the incumbent. Its runtime-host-admitted caller must exercise
     the explicit candidate endpoint instead of being redirected to the stable
     listener and grading the incumbent on the candidate's behalf. */
  if (pinConfiguredEndpoint) return configured;
  /* Redirecting a retired launch URL requires the complete release contract.
     A partial environment stays pinned to its explicit endpoint and
     cannot consult the operator's implicit state path or default port. */
  if (!env.LLV_VIEWER_DEPLOY_TARGET?.trim() || !env.LLV_VIEWER_PORT?.trim()) return configured;
  const currentRelease = currentReleaseOrigin(env);
  if (!currentRelease) return configured;
  if (loopbackOrigin(configured) === currentRelease) return currentRelease;
  return stableControlOrigin(env);
}
