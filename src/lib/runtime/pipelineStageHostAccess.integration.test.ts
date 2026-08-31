import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { prepareCodexIntegrationTestHome } from "./integrationTestHome";
import { materializeStructuredHostAccess } from "./structuredSpawn";

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
const isolatedHome = prepareCodexIntegrationTestHome(codexBinary);

afterAll(() => isolatedHome?.cleanup());

test.skipIf(!isolatedHome)("default stage host can read the network, call gh, and write its worktree", async () => {
  if (!isolatedHome) throw new Error("isolated Codex subscription home is unavailable");
  const checkoutDirectory = path.join(isolatedHome.directory, "checkout");
  fs.mkdirSync(checkoutDirectory, { mode: 0o700 });
  const githubConfig = process.env.GH_CONFIG_DIR
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "gh");
  const access = materializeStructuredHostAccess(
    false,
    { ...isolatedHome.env, GH_CONFIG_DIR: githubConfig },
    "integration-capability",
    isolatedHome.directory,
  );
  const host = await CodexAppServerHost.start({
    cwd: checkoutDirectory,
    binary: codexBinary,
    codexHome: isolatedHome.codexHome,
    env: access.env,
    fileAuthCredentials: true,
    ...access.codex,
    ...access.host,
    approvalPolicy: "never",
    requestTimeoutMs: 60_000,
    eventStore: new FileRuntimeEventStore(path.join(isolatedHome.directory, "events")),
  });
  const worktreeProbe = path.join(checkoutDirectory, "stage-report.md");
  try {
    const rpc = (host as unknown as {
      rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
    }).rpc.bind(host);
    const result = await rpc("command/exec", {
      command: [
        "/bin/sh",
        "-lc",
        "curl -fsSL -o /dev/null https://api.github.com/rate_limit && ssh -G github.com >/dev/null && gh api rate_limit --silent && printf report > \"$WORKTREE_PROBE\"",
      ],
      permissionProfile: ":danger-full-access",
      timeoutMs: 10_000,
      env: { WORKTREE_PROBE: worktreeProbe },
    }) as { exitCode: number; stdout: string; stderr: string };
    expect(result).toMatchObject({ exitCode: 0 });
    expect(fs.readFileSync(worktreeProbe, "utf8")).toBe("report");
  } finally {
    await host.release();
    access.cleanup();
  }
}, 120_000);
