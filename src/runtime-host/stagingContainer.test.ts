import { expect, test } from "bun:test";
import path from "node:path";

import type { ViewerComposeService } from "./candidateContainer";
import {
  STAGING_FRONT_PORT,
  STAGING_LABEL,
  STAGING_RUNTIME_HOST_CONTAINER,
  STAGING_VIEWER_CONTAINER,
  stagingImageName,
  stagingRuntimeHostDockerArgs,
  stagingStatePaths,
  stagingViewerDockerArgs,
} from "./stagingContainer";

const revision = "d".repeat(40);

const composeService = {
  build: { context: "/source", dockerfile: "Dockerfile" },
  command: ["sh", "-c", "exec bun-container --bun node_modules/.bin/next start --port \"$${PORT:-8898}\" --hostname \"$${HOSTNAME:-127.0.0.1}\""],
  entrypoint: null,
  environment: {
    HOME: "/home/user",
    HOSTNAME: "127.0.0.1",
    PORT: "8898",
    XDG_CONFIG_HOME: "/home/user/.config",
    XDG_CACHE_HOME: "/home/user/.cache",
    LLV_RUNTIME_EVENTS: "0",
    LLV_RUNTIME_HOST_SOCKET: "/home/user/.config/agent-log-viewer/state/runtime-host.sock",
    LLV_VIEWER_DEPLOY_TARGET: "/home/user/.config/agent-log-viewer/state/viewer-release.json",
    LLV_VIEWER_PORT: "8898",
    LLV_LEGACY_TMUX_EXTERNAL: "0",
    TMUX_TMPDIR: "/tmp",
    LLV_DOCKER_NSENTER_SHIMS: "1",
    GIT_SSH_COMMAND: "ssh compose-config",
  },
  image: "agent-log-viewer:node22",
  labels: { "compose.viewer": "production" },
  network_mode: "host",
  pid: "host",
  profiles: [],
  privileged: true,
  restart: "unless-stopped",
  "user": "1000:1000",
  volumes: [
    { type: "bind", source: "/home/user", target: "/home/user", bind: {} },
    { type: "bind", source: "/tmp/tmux-1000", target: "/tmp/tmux-1000", bind: {} },
  ],
  working_dir: "/app",
} satisfies ViewerComposeService;

const paths = stagingStatePaths("/home/user/.config/agent-log-viewer/state-staging");
const tmux = { legacyTmuxExternal: "0", tmuxTmpdir: "/tmp" };

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
}

function environmentFromArgs(args: string[]): Record<string, string> {
  return Object.fromEntries(valuesAfter(args, "-e").map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

test("the staging front port is a documented fixed port distinct from prod and tests", () => {
  expect(STAGING_FRONT_PORT).toBe(8899);
});

test("staging image names pin the deployed revision", () => {
  expect(stagingImageName(revision)).toBe(`agent-log-viewer:staging-${"d".repeat(12)}`);
  expect(() => stagingImageName("origin/stage")).toThrow();
});

test("staging state paths all live inside the staging state dir", () => {
  expect(paths.runtimeSocket.startsWith(`${paths.stateDir}${path.sep}`)).toBe(true);
  expect(paths.runtimeJournal.startsWith(`${paths.stateDir}${path.sep}`)).toBe(true);
});

test("the staging viewer container serves the fixed staging port from isolated state", () => {
  const args = stagingViewerDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths, tmux });
  const environment = environmentFromArgs(args);
  expect(valuesAfter(args, "--name")).toEqual([STAGING_VIEWER_CONTAINER]);
  expect(args[args.length - composeService.command.length - 1]).toBe(stagingImageName(revision));
  expect(environment.PORT).toBe("8899");
  expect(environment.LLV_STAGING).toBe("1");
  expect(environment.LLV_STATE_DIR).toBe(paths.stateDir);
  expect(environment.LLV_RUNTIME_EVENTS).toBe("1");
  expect(environment.LLV_RUNTIME_HOST_SOCKET).toBe(paths.runtimeSocket);
  /* The compose command keeps its legacy-launch gate, so the grant travels along. */
  expect(environment.LLV_ALLOW_LEGACY_VIEWER).toBe("1");
  expect(args.slice(-composeService.command.length + 2)[0]).toContain("next start");
});

test("staging containers are never labelled as prod-managed releases", () => {
  for (const args of [
    stagingViewerDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths, tmux }),
    stagingRuntimeHostDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths, tmux }),
  ]) {
    const labels = valuesAfter(args, "--label");
    expect(labels).toContain(`${STAGING_LABEL}=1`);
    expect(labels).toContain(`dev.live-log-viewer.revision=${revision}`);
    expect(labels.some((label) => label.startsWith("dev.live-log-viewer.managed="))).toBe(false);
  }
});

test("staging containers never carry prod deployment or release state env", () => {
  for (const args of [
    stagingViewerDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths, tmux }),
    stagingRuntimeHostDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths, tmux }),
  ]) {
    const environment = environmentFromArgs(args);
    expect(environment.LLV_VIEWER_DEPLOY_TARGET).toBeUndefined();
    expect(environment.LLV_VIEWER_PORT).toBeUndefined();
    expect(environment.LLV_STATE_DIR).toBe(paths.stateDir);
    expect(environment.LLV_STAGING).toBe("1");
  }
});

test("the staging runtime-host runs the events host against the staging journal without deployments", () => {
  const args = stagingRuntimeHostDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths, tmux });
  const environment = environmentFromArgs(args);
  expect(valuesAfter(args, "--name")).toEqual([STAGING_RUNTIME_HOST_CONTAINER]);
  expect(environment.LLV_RUNTIME_EVENTS).toBe("1");
  expect(environment.LLV_RUNTIME_JOURNAL).toBe(paths.runtimeJournal);
  expect(environment.LLV_RUNTIME_HOST_SOCKET).toBe(paths.runtimeSocket);
  expect(environment.LLV_VIEWER_DEPLOYMENTS).toBe("0");
  expect(args.slice(-3)).toEqual(["bun-container", "run", "src/runtime-host/main.ts"]);
});

test("staging container args refuse a state dir that resolves to prod state", () => {
  const prodPaths = stagingStatePaths("/home/user/.config/agent-log-viewer/state");
  expect(() => stagingViewerDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths: prodPaths, tmux }))
    .toThrow(/staging/i);
  expect(() => stagingRuntimeHostDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths: prodPaths, tmux }))
    .toThrow(/staging/i);
  const legacyPaths = stagingStatePaths("/home/user/.claude/viewer-state");
  expect(() => stagingViewerDockerArgs({ revision, image: stagingImageName(revision), service: composeService, paths: legacyPaths, tmux }))
    .toThrow(/staging/i);
});
