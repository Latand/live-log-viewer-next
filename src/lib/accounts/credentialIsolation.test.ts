import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-credential-isolation-test-"));
const previousState = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");

const { accountManager } = await import("./manager");
const { codexAppServerEnvironment } = await import("./codexAppServer");
const { claudeStatusEnvironment } = await import("./claudeLogin");
const {
  discardWakatimeEnvironmentCredential,
  WAKATIME_CREDENTIAL_ENV,
  withoutWakatimeCredential,
} = await import("../wakatime/credential");

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("agent launch environments exclude the Viewer-owned WakaTime credential", () => {
  const previous = process.env[WAKATIME_CREDENTIAL_ENV];
  const placeholder = ["fixture", "value"].join("-");
  Reflect.set(process.env, WAKATIME_CREDENTIAL_ENV, placeholder);
  try {
    const codex = accountManager.resolveSpawn("codex");
    const claude = accountManager.resolveSpawn("claude");
    const claudeStatus = claudeStatusEnvironment("/fixture/unrecognized");

    expect(codex.env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(claude.env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(claudeStatus[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(JSON.stringify({ codex: codex.env, claude: claude.env, claudeStatus })).not.toContain(placeholder);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, WAKATIME_CREDENTIAL_ENV);
    else Reflect.set(process.env, WAKATIME_CREDENTIAL_ENV, previous);
  }
});

test("Codex app-server children exclude the Viewer-owned WakaTime credential", () => {
  const previous = process.env[WAKATIME_CREDENTIAL_ENV];
  const placeholder = ["fixture", "value"].join("-");
  Reflect.set(process.env, WAKATIME_CREDENTIAL_ENV, placeholder);
  try {
    const env = codexAppServerEnvironment("/fixture/home");
    expect(env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(placeholder);
    expect(env.CODEX_HOME).toBe("/fixture/home");
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, WAKATIME_CREDENTIAL_ENV);
    else Reflect.set(process.env, WAKATIME_CREDENTIAL_ENV, previous);
  }
});

test("captured environment snapshots never read WakaTime key material", () => {
  const placeholder = ["snapshot", "fixture", "value"].join("-");
  let secretReads = 0;
  const source = new Proxy<NodeJS.ProcessEnv>({ NODE_ENV: "test" }, {
    ownKeys: () => ["NODE_ENV", WAKATIME_CREDENTIAL_ENV],
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    get: (target, property) => {
      if (property === WAKATIME_CREDENTIAL_ENV) {
        secretReads += 1;
        return placeholder;
      }
      return Reflect.get(target, property);
    },
  });

  const snapshot = withoutWakatimeCredential(source);

  expect(secretReads).toBe(0);
  expect(snapshot).toEqual({ NODE_ENV: "test" });
  expect(JSON.stringify(snapshot)).not.toContain(placeholder);
});

test("startup discards the unsupported environment credential without reading it", () => {
  const environment = new Proxy<NodeJS.ProcessEnv>({
    NODE_ENV: "test",
    [WAKATIME_CREDENTIAL_ENV]: "guarded",
  }, {
    get: (_target, property) => {
      if (property === WAKATIME_CREDENTIAL_ENV) throw new Error("secret value was read");
      return undefined;
    },
  });

  expect(() => discardWakatimeEnvironmentCredential(environment)).not.toThrow();
  expect(Object.hasOwn(environment, WAKATIME_CREDENTIAL_ENV)).toBe(false);
});
