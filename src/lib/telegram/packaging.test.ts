import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-packaging-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const {
  TELEGRAM_CONNECTOR_UPSTREAM,
  bridgeLaunchSpec,
  provisionSpec,
  telegramApiCredentials,
  telegramMcpUrl,
  vendoredConnectorDir,
  loginBridgePath,
} = await import("./packaging");

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("the vendored connector ships complete: source, lock, license, provenance", () => {
  const vendor = vendoredConnectorDir();
  for (const name of ["main.py", "pyproject.toml", "uv.lock", "LICENSE", "PROVENANCE.md", "SHA256SUMS", "telegram_mcp/runtime.py"]) {
    expect(fs.existsSync(path.join(vendor, name))).toBe(true);
  }
  /* The provenance file pins the exact release this slice was reviewed
     against; the constant and the document must agree. */
  const provenance = fs.readFileSync(path.join(vendor, "PROVENANCE.md"), "utf8");
  expect(TELEGRAM_CONNECTOR_UPSTREAM.release).toBe("v3.2.22");
  expect(TELEGRAM_CONNECTOR_UPSTREAM.commit).toBe("a61294362226bd93052f5a40b4a1b1269a99ce69");
  expect(provenance).toContain(TELEGRAM_CONNECTOR_UPSTREAM.commit);
  expect(provenance).toContain(TELEGRAM_CONNECTOR_UPSTREAM.release);
});

test("provisioning uses the vendored tree and its frozen lock, never an index name", () => {
  const spec = provisionSpec();
  expect(spec.command).toBe("uv");
  expect(spec.args).toContain("--frozen");
  expect(spec.args).toContain(vendoredConnectorDir());
  /* The poisoned PyPI name must never be an install argument. */
  expect(spec.args).not.toContain("telegram-mcp");
  expect(spec.env.UV_PROJECT_ENVIRONMENT).toContain(path.join("state", "telegram", "venv"));
});

test("the shared URL is loopback and matches what hosts register", () => {
  expect(telegramMcpUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
});

test("a standalone server (cwd inside dist/standalone) still finds the packaged assets", () => {
  const fakeRoot = path.join(SANDBOX, "packed-install");
  const standalone = path.join(fakeRoot, "dist", "standalone");
  fs.mkdirSync(standalone, { recursive: true });
  fs.mkdirSync(path.join(fakeRoot, "vendor", "telegram-mcp"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "vendor", "telegram-mcp", "pyproject.toml"), "");
  fs.mkdirSync(path.join(fakeRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "bin", "telegram-login-bridge.py"), "");
  const oldCwd = process.cwd();
  try {
    process.chdir(standalone);
    expect(vendoredConnectorDir()).toBe(path.join(fakeRoot, "vendor", "telegram-mcp"));
    expect(loginBridgePath()).toBe(path.join(fakeRoot, "bin", "telegram-login-bridge.py"));
    /* And the CLI's explicit env pin wins over the layout probe. */
    process.env.LLV_TELEGRAM_VENDOR_DIR = "/pinned/vendor";
    process.env.LLV_TELEGRAM_BRIDGE = "/pinned/bridge.py";
    expect(vendoredConnectorDir()).toBe("/pinned/vendor");
    expect(loginBridgePath()).toBe("/pinned/bridge.py");
  } finally {
    delete process.env.LLV_TELEGRAM_VENDOR_DIR;
    delete process.env.LLV_TELEGRAM_BRIDGE;
    process.chdir(oldCwd);
  }
});

test("the published tarball carries and runs the connector provisioner", () => {
  const packDirectory = path.join(SANDBOX, "pack-output");
  fs.mkdirSync(packDirectory, { recursive: true });
  const packed = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    cwd: path.resolve(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);
  /* npm emits either an array of reports or an object keyed by package name,
     depending on version; both carry the same per-file list. */
  const parsed = JSON.parse(packed.stdout.toString()) as unknown;
  const report = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed as Record<string, unknown>)[0]) as {
    filename: string;
    files: Array<{ path: string }>;
  };
  const shipped = new Set(report.files.map((file) => file.path));
  for (const required of [
    "bin/telegram-login-bridge.py",
    "bin/provision-telegram-connector.mjs",
    "vendor/telegram-mcp/SHA256SUMS",
    "vendor/telegram-mcp/PROVENANCE.md",
    "vendor/telegram-mcp/LICENSE",
    "vendor/telegram-mcp/pyproject.toml",
    "vendor/telegram-mcp/uv.lock",
    "vendor/telegram-mcp/main.py",
    "vendor/telegram-mcp/telegram_mcp/runtime.py",
  ]) {
    expect(shipped.has(required)).toBe(true);
  }

  const extracted = path.join(SANDBOX, "packed-install");
  fs.mkdirSync(extracted, { recursive: true });
  const unpacked = Bun.spawnSync({
    cmd: ["tar", "-xzf", path.join(packDirectory, report.filename), "-C", extracted],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(unpacked.exitCode).toBe(0);
  const packageRoot = path.join(extracted, "package");

  /* Execute from the extracted package with a fake uv. It records argv and
     materializes the expected venv result, exercising package-root discovery
     and the frozen vendored-project contract without network access. */
  const fakeBin = path.join(SANDBOX, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeUv = path.join(fakeBin, "uv");
  fs.writeFileSync(fakeUv, [
    "#!/bin/sh",
    "set -eu",
    "mkdir -p \"$UV_PROJECT_ENVIRONMENT/bin\"",
    "printf '%s\\n' \"$@\" > \"$UV_PROJECT_ENVIRONMENT/uv-args.txt\"",
    ": > \"$UV_PROJECT_ENVIRONMENT/bin/python\"",
    "",
  ].join("\n"));
  fs.chmodSync(fakeUv, 0o755);
  const installedState = path.join(SANDBOX, "installed-state");
  const provisioned = Bun.spawnSync({
    cmd: ["node", path.join(packageRoot, "bin", "provision-telegram-connector.mjs")],
    cwd: SANDBOX,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      LLV_STATE_DIR: installedState,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(provisioned.exitCode).toBe(0);
  expect(fs.existsSync(path.join(installedState, "telegram", "venv", "bin", "python"))).toBe(true);
  const uvArgs = fs.readFileSync(path.join(installedState, "telegram", "venv", "uv-args.txt"), "utf8").split("\n").filter(Boolean);
  expect(uvArgs).toEqual([
    "sync",
    "--frozen",
    "--no-dev",
    "--project",
    path.join(packageRoot, "vendor", "telegram-mcp"),
  ]);
});

test("bridge launches carry credentials in env only and no session anywhere", () => {
  const spec = bridgeLaunchSpec("enroll", { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" });
  expect(spec.args.join(" ")).not.toContain("12345");
  expect(spec.env.TELEGRAM_API_ID).toBe("12345");
  expect(spec.env.TELEGRAM_SESSION_STRING).toBeUndefined();
  /* The child env is minimal: no Viewer state paths, no inherited secrets. */
  expect(spec.env.LLV_STATE_DIR).toBeUndefined();
});

test("API credentials come from host configuration, not hardcoded values", () => {
  const oldId = process.env.LLV_TELEGRAM_API_ID;
  const oldHash = process.env.LLV_TELEGRAM_API_HASH;
  const oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
  delete process.env.LLV_TELEGRAM_API_ID;
  delete process.env.LLV_TELEGRAM_API_HASH;
  try {
    expect(telegramApiCredentials()).toBeNull();
    process.env.LLV_TELEGRAM_API_ID = "777";
    process.env.LLV_TELEGRAM_API_HASH = "hash-from-env";
    expect(telegramApiCredentials()).toEqual({ apiId: "777", apiHash: "hash-from-env" });
    delete process.env.LLV_TELEGRAM_API_ID;
    delete process.env.LLV_TELEGRAM_API_HASH;
    const dir = path.join(SANDBOX, "config", "agent-log-viewer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram.json"), JSON.stringify({ apiId: "888", apiHash: "hash-from-file" }));
    expect(telegramApiCredentials()).toEqual({ apiId: "888", apiHash: "hash-from-file" });
  } finally {
    if (oldId === undefined) delete process.env.LLV_TELEGRAM_API_ID; else process.env.LLV_TELEGRAM_API_ID = oldId;
    if (oldHash === undefined) delete process.env.LLV_TELEGRAM_API_HASH; else process.env.LLV_TELEGRAM_API_HASH = oldHash;
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  }
});
