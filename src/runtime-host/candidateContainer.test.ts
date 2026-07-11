import { expect, test } from "bun:test";

import { runtimeEventsEnabled, runtimeHostSocket } from "@/lib/runtime/flags";

import { obsoleteManagedViewerContainers, viewerCandidateDockerArgs, viewerCandidateTmuxEnvironment } from "./candidateContainer";

const candidate = {
  revision: "a".repeat(40),
  image: `agent-log-viewer:deploy-${"a".repeat(40)}`,
  container: "llv-deploy-candidate",
  endpoint: "http://127.0.0.1:18001",
};

test("promoted candidate receives the runtime deployment control plane", () => {
  const args = viewerCandidateDockerArgs(candidate, {
    uid: "1000",
    gid: "1000",
    envFile: "/config/service.env",
    envFileExists: true,
    runtimeSocket: "/state/runtime-host.sock",
    legacyTmuxExternal: "1",
    tmuxTmpdir: "/run/user/1000/agent-log-viewer",
  });
  const environment = {} as NodeJS.ProcessEnv;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-e") continue;
    const [key, ...value] = args[index + 1]!.split("=");
    environment[key!] = value.join("=");
  }

  expect(runtimeEventsEnabled(environment)).toBe(true);
  expect(runtimeHostSocket(environment)).toBe("/state/runtime-host.sock");
  expect(environment.LLV_LEGACY_TMUX_EXTERNAL).toBe("1");
  expect(environment.TMUX_TMPDIR).toBe("/run/user/1000/agent-log-viewer");
  expect(args).toContain("dev.live-log-viewer.managed=1");
  expect(args).toContain("--env-file");
  expect(args).toContain("--restart");
  expect(args[args.indexOf("--restart") + 1]).toBe("unless-stopped");
});

test("candidate tmux environment follows the durable migration marker", () => {
  const checked: string[] = [];
  expect(viewerCandidateTmuxEnvironment("/state", "1000", (filename) => {
    checked.push(filename);
    return true;
  })).toEqual({ legacyTmuxExternal: "1", tmuxTmpdir: "/run/user/1000/agent-log-viewer" });
  expect(checked).toEqual(["/state/legacy-tmux-migration-complete"]);

  expect(viewerCandidateTmuxEnvironment("/state", "1000", () => false)).toEqual({
    legacyTmuxExternal: "0",
    tmuxTmpdir: "/tmp",
  });
});

test("container retention keeps the serving and immediate rollback releases", () => {
  expect(obsoleteManagedViewerContainers(
    ["viewer-current", "viewer-rollback", "viewer-old-a", "viewer-old-b"],
    ["viewer-current", "viewer-rollback"],
  )).toEqual(["viewer-old-a", "viewer-old-b"]);
});
