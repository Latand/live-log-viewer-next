import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const enabled = process.env.LLV_WAKATIME_AMBIENT_CHILD === "1";
const ambientTest = enabled ? test : test.skip;

ambientTest("ambient startup produces isolated runtime and publication evidence", async () => {
  const credentialName = ["WAKA", "TIME_API_KEY"].join("");
  const credentialPlaceholder = process.env[credentialName];
  if (!credentialPlaceholder) throw new Error("ambient isolation fixture is unavailable");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-ambient-"));
  process.env.LLV_STATE_DIR = directory;
  try {
    const { registerNodeViewerRuntime } = await import("../../instrumentation");
    let publicEvidence = "";
    await registerNodeViewerRuntime(async () => {
      if (Object.hasOwn(process.env, credentialName)) throw new Error("startup isolation failed");

      const { viewerChildProcessOptions } = await import("../../../bin/server-runtime.mjs");
      const { AgentRegistry } = await import("../agent/registry");
      const {
        viewerCandidateDockerArgs,
        viewerComposeServiceFromConfig,
        viewerComposeSnapshotWithoutWakatimeCredential,
      } = await import("../../runtime-host/candidateContainer");
      const { createWakatimeSync } = await import("./sync");

      const rawConfig = JSON.stringify({
        services: {
          viewer: {
            build: null,
            command: null,
            entrypoint: null,
            environment: {
              KEEP_ME: "kept",
              [credentialName]: credentialPlaceholder,
            },
            image: "viewer:ambient-fixture",
            labels: {},
            network_mode: "host",
            pid: "host",
            profiles: [],
            privileged: false,
            restart: "unless-stopped",
            "user": "1000:1000",
            volumes: [],
            working_dir: "/app",
          },
          "runtime-host": {
            environment: { [credentialName]: credentialPlaceholder },
          },
        },
      });
      const snapshot = viewerComposeSnapshotWithoutWakatimeCredential(rawConfig);
      const snapshotPath = path.join(directory, "candidate-snapshot.json");
      fs.writeFileSync(snapshotPath, snapshot, { mode: 0o600 });
      const service = viewerComposeServiceFromConfig(snapshot);
      const dockerArguments = viewerCandidateDockerArgs(
        {
          container: "viewer-ambient-fixture",
          endpoint: "http://127.0.0.1:18001",
          image: "viewer:ambient-fixture",
          revision: "a".repeat(40),
        },
        service,
        {
          legacyTmuxExternal: "1",
          runtimeSocket: "/state/runtime-host.sock",
          tmuxTmpdir: "/run/user/1000/agent-log-viewer",
        },
      );
      const containerEnvironment = Object.fromEntries(dockerArguments.flatMap((argument, index) => {
        if (argument !== "-e") return [];
        const entry = dockerArguments[index + 1]!;
        const separator = entry.indexOf("=");
        return [[entry.slice(0, separator), entry.slice(separator + 1)]];
      }));

      const childOptions = viewerChildProcessOptions({
        env: {
          KEEP_ME: "kept",
          PATH: process.env.PATH,
          [credentialName]: credentialPlaceholder,
        },
      });
      const child = Bun.spawnSync([
        process.execPath,
        "--eval",
        "process.exit(Object.hasOwn(process.env, ['WAKA', 'TIME_API_KEY'].join('')) ? 71 : 0)",
      ], {
        env: childOptions.env,
        stderr: "pipe",
        stdout: "pipe",
      });
      if (child.exitCode !== 0) throw new Error("runtime child isolation failed");

      const statePath = path.join(directory, "wakatime-state.json");
      const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
      let persistedState = "";
      const schedulerLease = {
        isHeld: () => true,
        release: () => undefined,
      };
      const sync = createWakatimeSync({
        acquireSchedulerLease: () => schedulerLease,
        clearTimer: () => undefined,
        fetch: async () => new Response(null, { status: 204 }),
        logger: () => undefined,
        now: () => 1_700_000_000_000,
        random: () => 0.5,
        readCredential: () => null,
        readState: () => null,
        recentTurnWindows: () => ({ complete: true, prefixTruncated: false, windows: [] }),
        registrySnapshot: () => registry.snapshot(),
        scan: async () => ({ complete: true, files: [] }),
        scheduleInterval: () => ({ unref() {} }),
        scheduleTimeout: () => ({ unref() {} }),
        writeState: (state) => {
          persistedState = `${JSON.stringify(state, null, 2)}\n`;
          fs.writeFileSync(statePath, persistedState, { mode: 0o600 });
        },
      });
      await sync.tick();
      sync.stop();

      publicEvidence = JSON.stringify({
        candidateSnapshot: snapshot,
        containerEnvironment,
        dockerArguments,
        persistedState,
        runtimeChildExitCode: child.exitCode,
      });
      fs.writeFileSync(path.join(directory, "public-evidence.json"), publicEvidence, { mode: 0o600 });
      return { registerViewerRuntime: async () => undefined };
    });

    const persistedEvidence = fs.readdirSync(directory)
      .filter((entry) => fs.statSync(path.join(directory, entry)).isFile())
      .map((entry) => fs.readFileSync(path.join(directory, entry), "utf8"))
      .join("\n");
    for (const evidence of [publicEvidence, persistedEvidence]) {
      if (evidence.includes(credentialName) || evidence.includes(credentialPlaceholder)) {
        throw new Error("persisted or public isolation evidence is unsafe");
      }
    }
    expect(Object.hasOwn(process.env, credentialName)).toBe(false);
  } finally {
    delete process.env.LLV_STATE_DIR;
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
