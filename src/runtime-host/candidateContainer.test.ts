import { expect, test } from "bun:test";

import { runtimeEventsEnabled, runtimeHostSocket } from "@/lib/runtime/flags";

import { obsoleteManagedViewerContainers, viewerCandidateDockerArgs } from "./candidateContainer";

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
  });
  const environment = {} as NodeJS.ProcessEnv;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-e") continue;
    const [key, ...value] = args[index + 1]!.split("=");
    environment[key!] = value.join("=");
  }

  expect(runtimeEventsEnabled(environment)).toBe(true);
  expect(runtimeHostSocket(environment)).toBe("/state/runtime-host.sock");
  expect(args).toContain("dev.live-log-viewer.managed=1");
  expect(args).toContain("--env-file");
  expect(args).toContain("--restart");
  expect(args[args.indexOf("--restart") + 1]).toBe("unless-stopped");
});

test("container retention keeps the serving and immediate rollback releases", () => {
  expect(obsoleteManagedViewerContainers(
    ["viewer-current", "viewer-rollback", "viewer-old-a", "viewer-old-b"],
    ["viewer-current", "viewer-rollback"],
  )).toEqual(["viewer-old-a", "viewer-old-b"]);
});
