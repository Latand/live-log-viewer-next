import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import { structuredHostsEnabled as structuredHostsEnabledInApp } from "@/lib/runtime/flags";

import {
  structuredHostsEnabled as structuredHostsEnabledInLauncher,
  viewerServerBunRuntime,
  viewerChildProcessOptions,
  WAKATIME_CREDENTIAL_ENV,
  withoutWakatimeCredential,
} from "./server-runtime.mjs";

test("structured hosts select Bun for a CLI process launched by Node", () => {
  expect(viewerServerBunRuntime({
    env: { LLV_STRUCTURED_HOSTS: "1" },
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("bun");
  expect(viewerServerBunRuntime({
    env: { LLV_STRUCTURED_HOSTS: "1", LLV_BUN_EXECUTABLE: "/opt/bun/bin/bun" },
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("/opt/bun/bin/bun");
});

test("the packaged helper makes the same structured-runtime choice under Node", () => {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "server-runtime.mjs");
  const probe = Bun.spawnSync([
    "node",
    "--input-type=module",
    "--eval",
    `import { viewerServerBunRuntime } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(String(viewerServerBunRuntime()));`,
  ], {
    env: { ...process.env, LLV_STRUCTURED_HOSTS: "1", LLV_BUN_EXECUTABLE: "/verified/bun" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.toString()).toBe("/verified/bun");
});

/* Structured hosting is on by default, and it genuinely needs Bun (`bun:sqlite`
   journal, kernel start tokens on macOS). A launcher that still keyed on a
   literal "1" would run the default configuration under Node — where startup
   adoption throws the Darwin runtime requirement and the release controllers
   never start. */
test("an unset structured-hosts variable still selects Bun for the launcher", () => {
  expect(viewerServerBunRuntime({
    env: {},
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("bun");
});

/* `bin/` is plain JS outside the TS build, so its predicate is a copy. This
   pins the copy to the original: one truth table, both readers. */
test.each([
  [undefined],
  [""],
  ["1"],
  ["0"],
  [" 0 "],
  ["\"0\""],
  ["'0'"],
  ["false"],
  ["OFF"],
  ["no"],
  ["yes"],
] as const)("the launcher mirror and the app definition agree on %p", (value) => {
  const env = value === undefined ? {} : { LLV_STRUCTURED_HOSTS: value };
  expect(structuredHostsEnabledInLauncher(env)).toBe(structuredHostsEnabledInApp(env));
  // …and the launcher's Bun selection follows that one answer.
  expect(viewerServerBunRuntime({ env, versions: { node: "20.9.0" }, execPath: "/usr/bin/node" }) !== null)
    .toBe(structuredHostsEnabledInApp(env));
});

test("legacy Node mode stays available when Bun-only features are disabled", () => {
  expect(viewerServerBunRuntime({
    env: { LLV_AGENT_REGISTRY_SQLITE: "off", LLV_STRUCTURED_HOSTS: "0" },
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBeNull();
});

test("Viewer child processes receive no ambient WakaTime key material", () => {
  const placeholder = ["child", "fixture", "value"].join("-");
  const env = withoutWakatimeCredential({
    PATH: process.env.PATH,
    KEEP_ME: "kept",
    [WAKATIME_CREDENTIAL_ENV]: placeholder,
  });
  const probe = Bun.spawnSync([
    process.execPath,
    "--eval",
    "process.stdout.write(JSON.stringify({ keep: process.env.KEEP_ME, key: process.env.WAKATIME_API_KEY ?? null }))",
  ], { env, stdout: "pipe", stderr: "pipe" });

  expect(probe.exitCode).toBe(0);
  expect(JSON.parse(probe.stdout.toString())).toEqual({ keep: "kept", key: null });
  expect(JSON.stringify(env)).not.toContain(placeholder);
});

test("published launcher child options capture no ambient WakaTime key material", () => {
  const placeholder = ["launcher", "fixture", "value"].join("-");
  const options = viewerChildProcessOptions({
    cwd: "/viewer",
    env: {
      PATH: process.env.PATH,
      KEEP_ME: "kept",
      [WAKATIME_CREDENTIAL_ENV]: placeholder,
    },
    stdio: "ignore",
  });

  expect(options.env.KEEP_ME).toBe("kept");
  expect(options.env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
  expect(JSON.stringify(options)).not.toContain(placeholder);
});
