import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("fresh Claude and Codex registrations use the managed stable MCP executable", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-install-mcp-"));
  sandboxes.push(sandbox);
  const fakeBin = path.join(sandbox, "bin");
  const stableLauncher = path.join(sandbox, ".agents", "tools", "llv-mcp-runtime", "bin", "mcp-server.mjs");
  const claudeLog = path.join(sandbox, "claude.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(stableLauncher), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".codex"), { recursive: true });
  fs.writeFileSync(stableLauncher, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(sandbox, ".codex", "config.toml"), "", "utf8");
  const fakeClaude = path.join(fakeBin, "claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1 $2 $3" = "mcp get viewer" ]; then exit 1; fi
printf '%s\\n' "$*" >> "$LLV_TEST_CLAUDE_LOG"
`, { mode: 0o755 });

  const child = Bun.spawn({
    cmd: ["bash", path.join(process.cwd(), "scripts", "install-mcp.sh")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: sandbox,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      LLV_TEST_CLAUDE_LOG: claudeLog,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("claude[user]: viewer added");
  expect(fs.readFileSync(claudeLog, "utf8")).toContain(`mcp add viewer -s user -- bun ${stableLauncher}`);
  expect(fs.readFileSync(path.join(sandbox, ".codex", "config.toml"), "utf8"))
    .toContain(`args = ["${stableLauncher}"]`);
});
