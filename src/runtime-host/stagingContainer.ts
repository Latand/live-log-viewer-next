import path from "node:path";

import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import {
  AGENT_REGISTRY_SQLITE_ENV,
  viewerCandidateVolumes,
  viewerRegistryBackendMode,
  type ViewerCandidateContainerOverrides,
  type ViewerComposeService,
} from "./candidateContainer";

/**
 * Staging deployment target (#659). One fixed pair of containers serves the
 * `stage` branch beside prod: same image build path, simple replace (no
 * blue-green), own state dir. Front ports on this host: 8898 prod front
 * proxy, 8899 staging viewer (this constant), 8901 test compose default,
 * 18000–19999 prod blue-green candidates.
 */
export const STAGING_FRONT_PORT = 8899;

/** Staging containers carry this label INSTEAD of dev.live-log-viewer.managed,
    so prod retain/cleanup sweeps and candidate port reservation never see them. */
export const STAGING_LABEL = "dev.live-log-viewer.staging";

export const STAGING_VIEWER_CONTAINER = "llv-staging-viewer";
export const STAGING_RUNTIME_HOST_CONTAINER = "llv-staging-runtime-host";

export interface StagingStatePaths {
  stateDir: string;
  runtimeSocket: string;
  runtimeJournal: string;
}

/** Every mutable staging path hangs off the one staging state dir. */
export function stagingStatePaths(stateDir: string): StagingStatePaths {
  return {
    stateDir,
    runtimeSocket: path.join(stateDir, "runtime-host.sock"),
    runtimeJournal: path.join(stateDir, "runtime-events.sqlite"),
  };
}

export function stagingImageName(revision: string): string {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("staging image revision must be a full commit SHA");
  return `agent-log-viewer:staging-${revision.slice(0, 12)}`;
}

export interface StagingContainerContext {
  revision: string;
  image: string;
  service: ViewerComposeService;
  paths: StagingStatePaths;
  tmux: Pick<ViewerCandidateContainerOverrides, "legacyTmuxExternal" | "tmuxTmpdir">;
  port?: number;
}

/* The isolation guard at container-construction time: whatever the compose
   snapshot or the caller's configuration says, a staging container is never
   assembled around the prod state dir (or the legacy dirs that alias it). */
function assertIsolatedStateDir(context: StagingContainerContext): void {
  const home = context.service.environment.HOME;
  if (!home) throw new Error("Viewer Compose service HOME is required");
  const configRoot = context.service.environment.XDG_CONFIG_HOME || path.join(home, ".config");
  const prodDirs = [
    path.join(configRoot, "agent-log-viewer", "state"),
    path.join(configRoot, "live-log-viewer", "state"),
    path.join(home, ".claude", "viewer-state"),
  ];
  const resolved = path.resolve(context.paths.stateDir);
  if (prodDirs.some((prod) => path.resolve(prod) === resolved)) {
    throw new Error(`staging containers refuse the production state dir ${resolved}`);
  }
}

/* Shared shape for both staging containers: prod release/deployment env is
   stripped (LLV_VIEWER_DEPLOY_TARGET names prod's viewer-release.json and
   LLV_VIEWER_PORT the prod front port), and every state-bearing knob is
   repinned into the staging state dir. */
function stagingEnvironment(context: StagingContainerContext): Record<string, string> {
  const snapshot = withoutWakatimeCredential({
    ...context.service.environment,
    [AGENT_REGISTRY_SQLITE_ENV]: viewerRegistryBackendMode(context.service),
    LLV_STAGING: "1",
    LLV_STATE_DIR: context.paths.stateDir,
    LLV_RUNTIME_EVENTS: "1",
    LLV_RUNTIME_HOST_SOCKET: context.paths.runtimeSocket,
    LLV_LEGACY_TMUX_EXTERNAL: context.tmux.legacyTmuxExternal,
    TMUX_TMPDIR: context.tmux.tmuxTmpdir,
  });
  delete snapshot.LLV_VIEWER_DEPLOY_TARGET;
  delete snapshot.LLV_VIEWER_PORT;
  return Object.fromEntries(Object.entries(snapshot)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stagingDockerArgs(
  context: StagingContainerContext,
  container: string,
  environment: Record<string, string>,
  command: string[],
): string[] {
  assertIsolatedStateDir(context);
  const labels = {
    ...context.service.labels,
    [STAGING_LABEL]: "1",
    "dev.live-log-viewer.revision": context.revision,
  };
  const volumes = viewerCandidateVolumes(context.service, context.tmux);
  return [
    "docker", "run", "-d",
    "--restart", context.service.restart,
    "--name", container,
    ...Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--network", context.service.network_mode,
    "--pid", context.service.pid,
    ...(context.service.privileged ? ["--privileged"] : []),
    "--user", context.service.user,
    "--workdir", context.service.working_dir,
    ...Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...volumes.flatMap((volume) => [
      "--mount",
      `type=bind,source=${volume.source},target=${volume.target}${volume.read_only ? ",readonly" : ""}`,
    ]),
    context.image,
    ...command,
  ];
}

/** The staging Viewer: the compose viewer command on the fixed staging port. */
export function stagingViewerDockerArgs(context: StagingContainerContext): string[] {
  const port = context.port ?? STAGING_FRONT_PORT;
  const environment = {
    ...stagingEnvironment(context),
    PORT: String(port),
    LLV_ALLOW_LEGACY_VIEWER: "1",
  };
  const command = context.service.command?.map((argument) => argument.replaceAll("$$", () => "$")) ?? [];
  return stagingDockerArgs(context, STAGING_VIEWER_CONTAINER, environment, command);
}

/** The staging runtime-host: events host for spawn/attach/message delivery
    against the staging journal; Viewer deployments (and with them the prod
    front proxy and viewer-release writes) stay off. */
export function stagingRuntimeHostDockerArgs(context: StagingContainerContext): string[] {
  const environment: Record<string, string> = {
    ...stagingEnvironment(context),
    LLV_RUNTIME_JOURNAL: context.paths.runtimeJournal,
    LLV_VIEWER_DEPLOYMENTS: "0",
    LLV_RUNTIME_LEGACY_SCHEDULER: "0",
  };
  delete environment.PORT;
  return stagingDockerArgs(context, STAGING_RUNTIME_HOST_CONTAINER, environment, ["bun-container", "run", "src/runtime-host/main.ts"]);
}
