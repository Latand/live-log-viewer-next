import fs from "node:fs";
import path from "node:path";

import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";

export interface ViewerComposeVolume {
  type: "bind";
  source: string;
  target: string;
  read_only?: boolean;
  bind: Record<string, never>;
}

export interface ViewerComposeService {
  build: unknown;
  command: string[] | null;
  entrypoint: null;
  environment: Record<string, string>;
  image: string;
  labels: Record<string, string>;
  network_mode: string;
  pid: string;
  profiles: string[];
  privileged: boolean;
  restart: string;
  user: string;
  volumes: ViewerComposeVolume[];
  working_dir: string;
}

export interface ViewerCandidateContainerOverrides {
  runtimeSocket: string;
  legacyTmuxExternal: string;
  tmuxTmpdir: string;
}

const SERVICE_KEYS = new Set([
  "build", "command", "entrypoint", "environment", "image", "labels", "network_mode",
  "pid", "privileged", "profiles", "restart", "user", "volumes", "working_dir",
]);
const VOLUME_KEYS = new Set(["bind", "read_only", "source", "target", "type"]);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = objectValue(value, label);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") throw new Error(`${label}.${key} is invalid`);
  }
  return record as Record<string, string>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} is invalid`);
  return value as string[];
}

function assertCoveredKeys(record: Record<string, unknown>, supported: Set<string>, label: string): void {
  const uncovered = Object.keys(record).filter((key) => !supported.has(key));
  if (uncovered.length > 0) throw new Error(`${label} has uncovered fields: ${uncovered.sort().join(", ")}`);
}

function composeVolume(value: unknown, index: number): ViewerComposeVolume {
  const volume = objectValue(value, `viewer Compose volume ${index}`);
  assertCoveredKeys(volume, VOLUME_KEYS, `viewer Compose volume ${index}`);
  if (volume.type !== "bind") throw new Error(`viewer Compose volume ${index} type is unsupported`);
  const bind = objectValue(volume.bind ?? {}, `viewer Compose volume ${index}.bind`);
  if (Object.keys(bind).length > 0) throw new Error(`viewer Compose volume ${index}.bind has uncovered fields`);
  if (volume.read_only !== undefined && typeof volume.read_only !== "boolean") throw new Error(`viewer Compose volume ${index}.read_only is invalid`);
  return {
    type: "bind",
    source: stringValue(volume.source, `viewer Compose volume ${index}.source`),
    target: stringValue(volume.target, `viewer Compose volume ${index}.target`),
    ...(volume.read_only === undefined ? {} : { read_only: volume.read_only }),
    bind: {},
  };
}

export function viewerComposeServiceFromConfig(configJson: string): ViewerComposeService {
  const config = objectValue(JSON.parse(configJson), "Compose config");
  const services = objectValue(config.services, "Compose services");
  const viewer = objectValue(services.viewer, "Viewer Compose service");
  assertCoveredKeys(viewer, SERVICE_KEYS, "Viewer Compose service");
  if (viewer.entrypoint !== null) throw new Error("Viewer Compose entrypoint is unsupported");
  if (typeof viewer.privileged !== "boolean") throw new Error("Viewer Compose privileged is invalid");
  if (!Array.isArray(viewer.volumes)) throw new Error("Viewer Compose volumes are invalid");
  return {
    build: viewer.build,
    command: viewer.command === null ? null : stringArray(viewer.command, "Viewer Compose command"),
    entrypoint: null,
    environment: stringRecord(viewer.environment, "Viewer Compose environment"),
    image: stringValue(viewer.image, "Viewer Compose image"),
    labels: viewer.labels === undefined ? {} : stringRecord(viewer.labels, "Viewer Compose labels"),
    network_mode: stringValue(viewer.network_mode, "Viewer Compose network_mode"),
    pid: stringValue(viewer.pid, "Viewer Compose pid"),
    profiles: viewer.profiles === undefined ? [] : stringArray(viewer.profiles, "Viewer Compose profiles"),
    privileged: viewer.privileged,
    restart: stringValue(viewer.restart, "Viewer Compose restart"),
    user: stringValue(viewer.user, "Viewer Compose user"),
    volumes: viewer.volumes.map(composeVolume),
    working_dir: stringValue(viewer.working_dir, "Viewer Compose working_dir"),
  };
}

export function viewerAuthenticationTokenFromConfig(configJson: string): string | null {
  const token = viewerComposeServiceFromConfig(configJson).environment.LLV_TOKEN;
  return token || null;
}

export function viewerComposeServiceUid(service: ViewerComposeService): string {
  const uid = service.user.split(":", 1)[0];
  if (!uid || !/^\d+$/.test(uid)) throw new Error("Viewer Compose user must begin with a numeric uid");
  return uid;
}

export function viewerCandidateTmuxEnvironment(
  stateDir: string,
  uid: string,
  configured: Pick<ViewerCandidateContainerOverrides, "legacyTmuxExternal" | "tmuxTmpdir">,
  exists: (filename: string) => boolean = fs.existsSync,
): Pick<ViewerCandidateContainerOverrides, "legacyTmuxExternal" | "tmuxTmpdir"> {
  const migrationComplete = exists(path.join(stateDir, "legacy-tmux-migration-complete"));
  return migrationComplete
    ? { legacyTmuxExternal: "1", tmuxTmpdir: `/run/user/${uid}/agent-log-viewer` }
    : configured;
}

export function viewerCandidateDockerArgs(
  candidate: ViewerReleaseIdentity,
  service: ViewerComposeService,
  overrides: ViewerCandidateContainerOverrides,
): string[] {
  const endpoint = new URL(candidate.endpoint);
  const environment = {
    ...service.environment,
    PORT: endpoint.port,
    LLV_RUNTIME_EVENTS: "1",
    LLV_RUNTIME_HOST_SOCKET: overrides.runtimeSocket,
    LLV_LEGACY_TMUX_EXTERNAL: overrides.legacyTmuxExternal,
    LLV_ALLOW_LEGACY_VIEWER: "1",
    TMUX_TMPDIR: overrides.tmuxTmpdir,
  };
  const labels = {
    ...service.labels,
    "dev.live-log-viewer.managed": "1",
    "dev.live-log-viewer.revision": candidate.revision,
  };
  const command = service.command?.map((argument) => argument.replaceAll("$$", () => "$")) ?? [];
  const args = [
    "docker", "run", "-d",
    "--restart", service.restart,
    "--name", candidate.container,
    ...Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--network", service.network_mode,
    "--pid", service.pid,
    ...(service.privileged ? ["--privileged"] : []),
    "--user", service.user,
    "--workdir", service.working_dir,
    ...Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...service.volumes.flatMap((volume) => [
      "--mount",
      `type=bind,source=${volume.source},target=${volume.target}${volume.read_only ? ",readonly" : ""}`,
    ]),
    candidate.image,
    ...command,
  ];
  return args;
}

export function obsoleteManagedViewerContainers(containers: string[], keep: string[]): string[] {
  const retained = new Set(keep);
  return [...new Set(containers)].filter((container) => !retained.has(container));
}
