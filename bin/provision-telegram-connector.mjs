#!/usr/bin/env node
/**
 * Provisions the packaged Telegram connector environment (issue #1059).
 *
 * Builds the Viewer-owned Python venv from the vendored pinned source
 * (`vendor/telegram-mcp`, see its PROVENANCE.md) with `uv sync --frozen`, so a
 * clean installation can start the connector without a manual clone and
 * without ever resolving the poisoned `telegram-mcp` PyPI name.
 *
 * Ships in `bin/` with the published package (npm `files`), dependency-free,
 * so an installed `agent-log-viewer` can run it directly:
 *
 *   node bin/provision-telegram-connector.mjs      # or: bun run telegram:provision
 *
 * Environment (same contract as src/lib/telegram/packaging.ts):
 *   LLV_TELEGRAM_VENDOR_DIR  vendored tree (default: <package>/vendor/telegram-mcp)
 *   LLV_STATE_DIR            viewer state root (default: $XDG_CONFIG_HOME/agent-log-viewer/state)
 *   LLV_TELEGRAM_PYTHON      expected venv python (default: <state>/telegram/venv/bin/python)
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const UV_BOOTSTRAP_VERSION = "0.7.13";
const MAX_UV_ARCHIVE_BYTES = 64 * 1024 * 1024;
const UV_DOWNLOAD_TIMEOUT_MS = 120_000;
const UV_SELF_CHECK_TIMEOUT_MS = 10_000;
const CONNECTOR_PROVISION_TIMEOUT_MS = 10 * 60_000;
const UV_RELEASES = Object.freeze({
  "darwin-arm64": { triple: "aarch64-apple-darwin", sha256: "721f532b73171586574298d4311a91d5ea2c802ef4db3ebafc434239330090c6" },
  "darwin-x64": { triple: "x86_64-apple-darwin", sha256: "d785753ac092e25316180626aa691c5dfe1fb075290457ba4fdb72c7c5661321" },
  "linux-arm64-gnu": { triple: "aarch64-unknown-linux-gnu", sha256: "0b2ad9fe4295881615295add8cc5daa02549d29cc9a61f0578e397efcf12f08f" },
  "linux-arm64-musl": { triple: "aarch64-unknown-linux-musl", sha256: "52baba71881c978d32b7c32216ad0cde4546a4dc62e606c9834ec4616c1610eb" },
  "linux-x64-gnu": { triple: "x86_64-unknown-linux-gnu", sha256: "909278eb197c5ed0e9b5f16317d1255270d1f9ea4196e7179ce934d48c4c2545" },
  "linux-x64-musl": { triple: "x86_64-unknown-linux-musl", sha256: "560bb64e060354e45138d7dd47c8dd48a4f7a349af5520d29cd3c704e79f286c" },
});

function usesGlibc() {
  return Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
}

export function uvReleaseFor(platform = process.platform, arch = process.arch, glibc = usesGlibc()) {
  const libc = platform === "linux" ? (glibc ? "-gnu" : "-musl") : "";
  const release = UV_RELEASES[`${platform}-${arch}${libc}`];
  if (!release) throw new Error(`unsupported uv bootstrap target ${platform}-${arch}${libc}`);
  const asset = `uv-${release.triple}.tar.gz`;
  return {
    ...release,
    asset,
    url: `https://github.com/astral-sh/uv/releases/download/${UV_BOOTSTRAP_VERSION}/${asset}`,
  };
}

function ownerOnlyDirectory(pathname) {
  if (!existsSync(pathname)) mkdirSync(pathname, { recursive: true, mode: 0o700 });
  const stat = lstatSync(pathname);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("telegram state directory is not owner-only");
  }
}

function commandRuns(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: UV_SELF_CHECK_TIMEOUT_MS });
  return !result.error && result.status === 0;
}

export async function installPinnedUv(toolsDir, options = {}) {
  const release = options.release || uvReleaseFor();
  const fetcher = options.fetcher || fetch;
  ownerOnlyDirectory(toolsDir);
  const destination = join(toolsDir, "uv");
  if (existsSync(destination)) {
    const existing = lstatSync(destination);
    if (existing.isSymbolicLink() || !existing.isFile() || (existing.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && existing.uid !== process.getuid())) {
      throw new Error("installed uv executable is unsafe");
    }
    if (commandRuns(destination)) return destination;
    throw new Error("installed uv executable failed its self-check");
  }

  const installDir = join(toolsDir, `.uv-install-${process.pid}-${randomUUID()}`);
  const archive = join(installDir, release.asset);
  mkdirSync(installDir, { mode: 0o700 });
  try {
    const response = await fetcher(release.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(UV_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`uv download failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UV_ARCHIVE_BYTES) throw new Error("uv archive is oversized");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_UV_ARCHIVE_BYTES) throw new Error("uv archive has an invalid size");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== release.sha256) throw new Error("uv archive checksum mismatch");
    writeFileSync(archive, bytes, { mode: 0o600 });
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", installDir], { stdio: "ignore" });
    if (extracted.error || extracted.status !== 0) throw new Error("uv archive extraction failed");
    const source = join(installDir, `uv-${release.triple}`, "uv");
    if (!existsSync(source)) throw new Error("uv archive did not contain the expected executable");
    chmodSync(source, 0o700);
    renameSync(source, destination);
    chmodSync(destination, 0o700);
    if (!commandRuns(destination)) throw new Error("installed uv executable failed its self-check");
    return destination;
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

export async function provisionTelegramConnector(env = process.env) {
  const vendorDir = env.LLV_TELEGRAM_VENDOR_DIR || join(packageRoot, "vendor", "telegram-mcp");
  const stateDir = env.LLV_STATE_DIR
    || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-log-viewer", "state");
  const venvDir = join(stateDir, "telegram", "venv");
  const venvPython = env.LLV_TELEGRAM_PYTHON || join(venvDir, "bin", "python");
  const telegramStateDir = dirname(venvDir);
  if (!existsSync(join(vendorDir, "pyproject.toml"))) throw new Error("vendored connector is unavailable");
  ownerOnlyDirectory(telegramStateDir);

  const uvCommand = await installPinnedUv(join(telegramStateDir, "tools"));
  /* The packaged tree can sit on a read-only filesystem (#1081), while the
     vendored runtime's supply-chain guard requires running from a source
     checkout and setuptools writes build metadata into the project dir. So:
     stage a writable owner-only copy at a STABLE path, editable-install from
     it, and keep it — the connector runs from this copy (#1084). */
  const sourceDir = join(telegramStateDir, "vendor-src");
  const incoming = join(telegramStateDir, `.vendor-src-${process.pid}-${randomUUID()}`);
  try {
    cpSync(vendorDir, incoming, { recursive: true });
    chmodSync(incoming, 0o700);
    rmSync(sourceDir, { recursive: true, force: true });
    renameSync(incoming, sourceDir);
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }

  const result = spawnSync(uvCommand, ["sync", "--frozen", "--no-dev", "--project", sourceDir], {
    cwd: sourceDir,
    env: { ...env, UV_PROJECT_ENVIRONMENT: venvDir },
    stdio: "inherit",
    timeout: CONNECTOR_PROVISION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const failed = () => {
    /* A partial venv must never pass a later provisioned check (#1084). */
    rmSync(venvDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  };
  if (result.error || result.status !== 0) {
    failed();
    throw new Error("connector dependency provisioning failed");
  }
  if (!existsSync(venvPython)) {
    failed();
    throw new Error("provisioning completed without a Python executable");
  }
  /* Success is a verified import, recorded durably — bare venv existence has
     already lied once (#1084). */
  const probe = spawnSync(venvPython, ["-c", "import telethon, telegram_mcp"], {
    stdio: "ignore",
    timeout: UV_SELF_CHECK_TIMEOUT_MS * 6,
  });
  if (probe.error || probe.status !== 0) {
    failed();
    throw new Error("provisioned environment failed its import probe");
  }
  writeFileSync(join(venvDir, ".llv-provisioned"), "ok\n", { mode: 0o600 });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  provisionTelegramConnector().catch((error) => {
    console.error("telegram connector provisioning failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
