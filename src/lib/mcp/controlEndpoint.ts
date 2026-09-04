import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerComposeSnapshotPath } from "@/runtime-host/deploymentArtifacts";

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

export const VIEWER_CONTROL_TOKEN_ENV = "LLV_VIEWER_CONTROL_TOKEN";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readJsonRecord(filename: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/* A credential travels in an HTTP header, so a value that cannot appear in one
   counts as absent. Sending nothing draws the Viewer's own legible refusal;
   throwing at header construction would take the whole tool call down first.
   The line sits where a header field value's does: printable ASCII, the space
   included, because the Viewer matches `Bearer\s+(.+)` and authenticates a key
   holding one — discarding it here would only move #1511's 403 from the gate
   into this client. Everything outside that range stays absent: a control byte
   is no part of a field value, and a non-ASCII one this runtime either refuses
   to construct or re-encodes into a key the Viewer never configured. */
function credential(value: unknown): string | null {
  const token = typeof value === "string" ? value.trim() : "";
  return token.length > 0 && !/[^\x20-\x7e]/.test(token) ? token : null;
}

function configRoot(env: ControlEnvironment): string {
  /* `os.homedir()` rather than `$HOME`, matching the launcher: on Windows HOME
     is not a Windows variable at all. */
  return env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
}

function stateDirectory(env: ControlEnvironment): string {
  return env.LLV_STATE_DIR?.trim() || path.join(configRoot(env), "agent-log-viewer", "state");
}

function releaseTargetFile(env: ControlEnvironment, stateDir: string): string {
  return env.LLV_VIEWER_DEPLOY_TARGET?.trim() || path.join(stateDir, "viewer-release.json");
}

/** Whether `origin` is the Viewer this machine's own release state names — its
    release endpoint, or the stable listener in front of it. An ambient
    credential travels only there: an endpoint someone else pointed this client
    at gets no key of the operator's. */
function addressesOwnViewer(
  env: ControlEnvironment,
  origin: string,
  target: Record<string, unknown> | null,
): boolean {
  if (origin === loopbackOrigin(target?.endpoint)) return true;
  try {
    return origin === stableControlOrigin(env);
  } catch {
    return false;
  }
}

/** The exact environment the running Viewer enforces, from the release
    container's Compose snapshot (0600, inside the operator's 0700 state). */
function releaseCredential(stateDir: string, target: Record<string, unknown> | null): string | null {
  const container = typeof target?.container === "string" && target.container.trim() ? target.container : null;
  if (!container) return null;
  const compose = readJsonRecord(viewerComposeSnapshotPath(stateDir, container));
  return credential(record(record(record(compose?.services)?.viewer)?.environment)?.LLV_TOKEN);
}

/** The key the CLI writes for its own links, which is what a Viewer started
    outside a deployment authenticates against. */
function machineKey(env: ControlEnvironment): string | null {
  try {
    return credential(fs.readFileSync(path.join(configRoot(env), "agent-log-viewer", "token"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The credential a control request must carry. #1496 made the Viewer
 * authenticate every connection whenever a token is configured, loopback
 * included, because loopback is shared by every OS account. This client sent
 * none, so a candidate's own deployment probe was refused by the release it was
 * grading, and every agent's Viewer tools would have answered 403 the moment
 * such a build was promoted (#1511).
 *
 * Agent processes are launched with `LLV_TOKEN` unset on purpose, so the key is
 * resolved from the same operator-only state that already names the control
 * origin, never from the agent's environment. A caller that pinned its own
 * credential keeps it; nothing else travels to an endpoint the release state
 * does not name; and a Viewer with no token configured still gets a bare
 * request, which is what it expects.
 */
export function viewerControlToken(env: ControlEnvironment, origin: string): string | null {
  const pinned = credential(env[VIEWER_CONTROL_TOKEN_ENV]);
  if (pinned) return pinned;
  /* The same rule the origin resolution follows: a client pinned to an explicit
     endpoint by a partial release environment consults no ambient state, so it
     can neither resolve a credential there nor send one to that endpoint. */
  if (env.LLV_VIEWER_CONTROL_URL?.trim()
    && (!env.LLV_VIEWER_DEPLOY_TARGET?.trim() || !env.LLV_VIEWER_PORT?.trim())) return null;
  const stateDir = stateDirectory(env);
  const target = readJsonRecord(releaseTargetFile(env, stateDir));
  if (!addressesOwnViewer(env, origin, target)) return null;
  return credential(env.LLV_TOKEN) ?? releaseCredential(stateDir, target) ?? machineKey(env);
}
