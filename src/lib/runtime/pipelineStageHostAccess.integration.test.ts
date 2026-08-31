import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { prepareCodexIntegrationTestHome } from "./integrationTestHome";
import { materializeStructuredHostAccess } from "./structuredSpawn";
import { pipelineStageSandbox } from "../pipelines/stageAccess";

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
const isolatedHome = prepareCodexIntegrationTestHome(codexBinary);

afterAll(() => isolatedHome?.cleanup());

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Git fixture command failed: ${args[0] ?? "unknown"}`);
}

test.skipIf(!isolatedHome)("default stage host can read the network, call gh, and write its worktree", async () => {
  if (!isolatedHome) throw new Error("isolated Codex subscription home is unavailable");
  const repositoryDirectory = path.join(isolatedHome.directory, "repository");
  fs.mkdirSync(repositoryDirectory, { mode: 0o700 });
  git(repositoryDirectory, "init", "--initial-branch=main");
  fs.writeFileSync(path.join(repositoryDirectory, "README.md"), "fixture\n");
  git(repositoryDirectory, "add", "README.md");
  git(repositoryDirectory, "-c", "user.name=Pipeline Test", "-c", "user.email=pipeline-test", "commit", "-m", "fixture");
  const checkoutDirectory = path.join(isolatedHome.directory, "checkout");
  git(repositoryDirectory, "worktree", "add", "-b", "pipeline/host-access", checkoutDirectory);
  const githubConfig = process.env.GH_CONFIG_DIR
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "gh");
  const sandbox = pipelineStageSandbox({ effectiveRole: { access: "read-only" } });
  const access = materializeStructuredHostAccess(
    sandbox === "restricted",
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
        "curl -fsSL -o /dev/null https://api.github.com/rate_limit && ssh -G github.com >/dev/null && ssh-keyscan -T 10 -p 443 ssh.github.com >/dev/null 2>&1 && gh api rate_limit --silent && printf report > \"$WORKTREE_PROBE\"",
      ],
      permissionProfile: access.codex.permissionProfile ?? `:${access.codex.sandbox ?? "read-only"}`,
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
