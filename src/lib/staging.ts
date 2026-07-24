/**
 * Staging instance mode (#659). A staging deployment serves the `stage`
 * branch on its own fixed front port so the operator can review features
 * next to prod. The hard contract is state isolation: a staging process must
 * never read or mutate prod viewer-release state, the agent registry,
 * runtime events, the board, or pipelines. Agent launches stay enabled —
 * they run against staging's own state — and the UI shows a staging badge
 * instead of refusing operator actions (operator revision, 2026-07-24).
 */

export const STAGING_MODE_ENV = "LLV_STAGING";

/** Default staging state dir name, a sibling of the prod `state` dir. */
export const STAGING_STATE_DIRNAME = "state-staging";

/** Inspectable record of the deployed staging revision, inside the staging state dir. */
export const STAGING_RELEASE_FILE = "staging-release.json";

export function isStagingMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STAGING_MODE_ENV] === "1";
}

export interface StagingReleaseRecord {
  revision: string;
  image: string;
  endpoint: string;
  containers: { viewer: string; runtimeHost: string };
  deployedAt: string;
}

/** Validating parse shared by the deploy script (writer) and /api/staging (reader). */
export function stagingReleaseRecord(value: unknown): StagingReleaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("staging release record is invalid");
  const record = value as Record<string, unknown>;
  const containers = record.containers;
  if (typeof record.revision !== "string" || !/^[0-9a-f]{40}$/.test(record.revision)
    || typeof record.image !== "string" || !record.image
    || typeof record.deployedAt !== "string" || Number.isNaN(Date.parse(record.deployedAt))
    || !containers || typeof containers !== "object" || Array.isArray(containers)) {
    throw new Error("staging release record is invalid");
  }
  if (typeof record.endpoint !== "string") throw new Error("staging release record is invalid");
  let endpoint: URL;
  try { endpoint = new URL(record.endpoint); }
  catch { throw new Error("staging release endpoint is invalid"); }
  if (endpoint.protocol !== "http:" || !endpoint.port) throw new Error("staging release endpoint is invalid");
  const pair = containers as Record<string, unknown>;
  if (typeof pair.viewer !== "string" || !pair.viewer || typeof pair.runtimeHost !== "string" || !pair.runtimeHost) {
    throw new Error("staging release containers are invalid");
  }
  return {
    revision: record.revision,
    image: record.image,
    endpoint: record.endpoint,
    containers: { viewer: pair.viewer, runtimeHost: pair.runtimeHost },
    deployedAt: record.deployedAt,
  };
}
