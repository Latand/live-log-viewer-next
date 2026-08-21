import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
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
  telegramProvisionerPath,
  vendoredConnectorDir,
  loginBridgePath,
  telegramMcpServerPath,
  telegramSessionReaderPath,
} = await import("./packaging");
const { installPinnedUv, uvReleaseFor, UV_BOOTSTRAP_VERSION } = await import("../../../bin/provision-telegram-connector.mjs");

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

test("clean-install uv bootstrap is platform-pinned and checksum-verified", async () => {
  expect(UV_BOOTSTRAP_VERSION).toBe("0.7.13");
  expect(uvReleaseFor("linux", "x64", true)).toMatchObject({
    triple: "x86_64-unknown-linux-gnu",
    sha256: "909278eb197c5ed0e9b5f16317d1255270d1f9ea4196e7179ce934d48c4c2545",
  });
  expect(uvReleaseFor("darwin", "arm64")).toMatchObject({
    triple: "aarch64-apple-darwin",
    sha256: "721f532b73171586574298d4311a91d5ea2c802ef4db3ebafc434239330090c6",
  });

  const triple = "fixture-platform";
  const fixtureRoot = path.join(SANDBOX, `uv-${triple}`);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixtureUv = path.join(fixtureRoot, "uv");
  fs.writeFileSync(fixtureUv, "#!/bin/sh\n[ \"${1:-}\" = \"--version\" ]\n", { mode: 0o700 });
  const archive = path.join(SANDBOX, "uv-fixture.tar.gz");
  const packed = Bun.spawnSync({
    cmd: ["tar", "-czf", archive, "-C", SANDBOX, `uv-${triple}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);
  const bytes = fs.readFileSync(archive);
  const release = {
    triple,
    asset: "uv-fixture.tar.gz",
    url: "https://example.invalid/uv-fixture.tar.gz",
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const fetcher = async () => new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.length) },
  });
  const toolsDir = path.join(SANDBOX, "bootstrapped-tools");
  const installed = await installPinnedUv(toolsDir, { release, fetcher });
  expect(installed).toBe(path.join(toolsDir, "uv"));
  expect(fs.statSync(installed).mode & 0o777).toBe(0o700);

  const rejectedTools = path.join(SANDBOX, "rejected-tools");
  await expect(installPinnedUv(rejectedTools, {
    release: { ...release, sha256: "0".repeat(64) },
    fetcher,
  })).rejects.toThrow("checksum mismatch");
  expect(fs.existsSync(path.join(rejectedTools, "uv"))).toBe(false);
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
  fs.writeFileSync(path.join(fakeRoot, "bin", "telegram-mcp-server.py"), "");
  fs.writeFileSync(path.join(fakeRoot, "bin", "telegram-session-reader.mjs"), "");
  fs.writeFileSync(path.join(fakeRoot, "bin", "provision-telegram-connector.mjs"), "");
  const oldCwd = process.cwd();
  try {
    process.chdir(standalone);
    expect(vendoredConnectorDir()).toBe(path.join(fakeRoot, "vendor", "telegram-mcp"));
    expect(loginBridgePath()).toBe(path.join(fakeRoot, "bin", "telegram-login-bridge.py"));
    expect(telegramMcpServerPath()).toBe(path.join(fakeRoot, "bin", "telegram-mcp-server.py"));
    expect(telegramSessionReaderPath()).toBe(path.join(fakeRoot, "bin", "telegram-session-reader.mjs"));
    expect(telegramProvisionerPath()).toBe(path.join(fakeRoot, "bin", "provision-telegram-connector.mjs"));
    /* And the CLI's explicit env pin wins over the layout probe. */
    process.env.LLV_TELEGRAM_VENDOR_DIR = "/pinned/vendor";
    process.env.LLV_TELEGRAM_BRIDGE = "/pinned/bridge.py";
    process.env.LLV_TELEGRAM_SERVER_BRIDGE = "/pinned/server.py";
    process.env.LLV_TELEGRAM_SESSION_READER = "/pinned/session-reader.mjs";
    process.env.LLV_TELEGRAM_PROVISIONER = "/pinned/provisioner.mjs";
    expect(vendoredConnectorDir()).toBe("/pinned/vendor");
    expect(loginBridgePath()).toBe("/pinned/bridge.py");
    expect(telegramMcpServerPath()).toBe("/pinned/server.py");
    expect(telegramSessionReaderPath()).toBe("/pinned/session-reader.mjs");
    expect(telegramProvisionerPath()).toBe("/pinned/provisioner.mjs");
  } finally {
    delete process.env.LLV_TELEGRAM_VENDOR_DIR;
    delete process.env.LLV_TELEGRAM_BRIDGE;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    delete process.env.LLV_TELEGRAM_SESSION_READER;
    delete process.env.LLV_TELEGRAM_PROVISIONER;
    process.chdir(oldCwd);
  }
});

test("the published tarball carries and runs the connector provisioner", async () => {
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
    "bin/telegram-mcp-server.py",
    "bin/telegram-session-reader.mjs",
    "bin/telegram-session-validator.mjs",
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
    "if [ \"${1:-}\" = \"--version\" ]; then exit 0; fi",
    "mkdir -p \"$UV_PROJECT_ENVIRONMENT/bin\"",
    "printf '%s\\n' \"$@\" > \"$UV_PROJECT_ENVIRONMENT/uv-args.txt\"",
    "printf '#!/bin/sh\\nexit 0\\n' > \"$UV_PROJECT_ENVIRONMENT/bin/python\"",
    "chmod 700 \"$UV_PROJECT_ENVIRONMENT/bin/python\"",
    "",
  ].join("\n"));
  fs.chmodSync(fakeUv, 0o700);
  const installedState = path.join(SANDBOX, "installed-state");
  const installedTools = path.join(installedState, "telegram", "tools");
  fs.mkdirSync(installedTools, { recursive: true, mode: 0o700 });
  fs.copyFileSync(fakeUv, path.join(installedTools, "uv"));
  fs.chmodSync(path.join(installedTools, "uv"), 0o700);
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
  expect(fs.statSync(path.join(installedState, "telegram")).mode & 0o777).toBe(0o700);
  const uvArgs = fs.readFileSync(path.join(installedState, "telegram", "venv", "uv-args.txt"), "utf8").split("\n").filter(Boolean);
  /* #1081/#1084: provisioning editable-syncs a writable owner-only staged
     copy at a stable path (the vendored runtime's supply-chain guard needs a
     source checkout), keeps it for the connector to run from, and records
     success only after the import probe. */
  const stagedSource = path.join(installedState, "telegram", "vendor-src");
  expect(uvArgs).toEqual(["sync", "--frozen", "--no-dev", "--project", stagedSource]);
  expect(fs.existsSync(path.join(stagedSource, "pyproject.toml"))).toBe(true);
  expect(fs.existsSync(path.join(installedState, "telegram", "venv", ".llv-provisioned"))).toBe(true);

  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = installedState;
  try {
    const { readTelegramSession, saveTelegramSession } = await import("./sessionStore");
    saveTelegramSession("1ApWapzMBu4placeholder-not-a-real-session");
    expect(readTelegramSession()?.sessionString).toBe("1ApWapzMBu4placeholder-not-a-real-session");
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
}, 30_000);

test("the packaged MCP entrypoint enforces bearer auth and token-bound identity", () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const fakeVendor = path.join(SANDBOX, "auth-wrapper-vendor");
  for (const directory of ["mcp/server", "telegram_mcp"]) {
    fs.mkdirSync(path.join(fakeVendor, directory), { recursive: true });
    fs.writeFileSync(path.join(fakeVendor, directory, "__init__.py"), "");
  }
  fs.writeFileSync(path.join(fakeVendor, "mcp", "__init__.py"), "");
  fs.writeFileSync(path.join(fakeVendor, "mcp", "server", "fastmcp.py"), [
    "class _Server:",
    "    name = 'telegram'",
    "class FastMCP:",
    "    def __init__(self): self._mcp_server = _Server()",
    "    def streamable_http_app(self):",
    "        async def app(scope, receive, send):",
    "            await send({'type': 'http.response.start', 'status': 204, 'headers': []})",
    "            await send({'type': 'http.response.body', 'body': b''})",
    "        return app",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(fakeVendor, "telegram_mcp", "runtime.py"), [
    "from mcp.server.fastmcp import FastMCP",
    "mcp = FastMCP()",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(fakeVendor, "telegram_mcp", "runner.py"), [
    "import asyncio, hashlib, hmac, json, os",
    "from telegram_mcp.runtime import mcp",
    "async def request(headers, path='/mcp', method='POST'):",
    "    statuses = []",
    "    bodies = []",
    "    async def receive(): return {'type': 'http.request', 'body': b'', 'more_body': False}",
    "    async def send(message):",
    "        if message['type'] == 'http.response.start': statuses.append(message['status'])",
    "        if message['type'] == 'http.response.body': bodies.append(message.get('body', b''))",
    "    await mcp.streamable_http_app()({'type': 'http', 'headers': headers, 'path': path, 'method': method}, receive, send)",
    "    return statuses[0], b''.join(bodies).decode()",
    "def main():",
    "    token = os.environ['LLV_TELEGRAM_MCP_TOKEN'].encode()",
    "    statuses = asyncio.run(run_all(token))",
    "    print(json.dumps({'name': mcp._mcp_server.name, **statuses}))",
    "async def run_all(token):",
    "    nonce = b'C' * 43",
    "    denied, _ = await request([])",
    "    wrong, _ = await request([(b'authorization', b'Bearer wrong')])",
    "    allowed, _ = await request([(b'authorization', b'Bearer ' + token)])",
    "    proof_status, proof = await request([(b'x-llv-telegram-nonce', nonce)], '/llv-telegram-proof', 'GET')",
    "    expected = hmac.new(token, nonce, hashlib.sha256).hexdigest()",
    "    return {'statuses': [denied, wrong, allowed], 'proof_status': proof_status, 'proof_matches': proof == expected}",
    "",
  ].join("\n"));
  const connectorToken = "B".repeat(43);
  const result = Bun.spawnSync({
    cmd: [python!, path.resolve(import.meta.dir, "..", "..", "..", "bin", "telegram-mcp-server.py")],
    env: { ...process.env, LLV_TELEGRAM_VENDOR_DIR: fakeVendor, LLV_TELEGRAM_MCP_TOKEN: connectorToken },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString()) as { name: string; statuses: number[]; proof_status: number; proof_matches: boolean };
  expect(output.statuses).toEqual([401, 401, 204]);
  expect(output.proof_status).toBe(200);
  expect(output.proof_matches).toBe(true);
  expect(output.name).toMatch(/^telegram-[a-f0-9]{64}$/);
});

test("health and logout bridges acquire the vendored session lock before connecting", () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const modules = path.join(SANDBOX, "bridge-lock-modules");
  for (const directory of ["telegram_mcp", "telethon"]) {
    fs.mkdirSync(path.join(modules, directory), { recursive: true });
    fs.writeFileSync(path.join(modules, directory, "__init__.py"), "");
  }
  fs.writeFileSync(path.join(modules, "telegram_mcp", "singleton.py"), [
    "LOCKED = False",
    "class SessionLock:",
    "    def __init__(self, label, identity): pass",
    "    def acquire(self, **kwargs):",
    "        global LOCKED",
    "        LOCKED = True",
    "    def release(self):",
    "        global LOCKED",
    "        LOCKED = False",
    "class SessionLockError(RuntimeError): pass",
    "def session_identity(client): return 'fixture-session'",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(modules, "telethon", "sessions.py"), [
    "class StringSession:",
    "    def __init__(self, value=None): self.value = value",
    "    def save(self): return self.value or 'fixture-session'",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(modules, "telethon", "errors.py"), [
    "class AuthKeyDuplicatedError(Exception): pass",
    "class AuthKeyUnregisteredError(Exception): pass",
    "class PasswordHashInvalidError(Exception): pass",
    "class SessionPasswordNeededError(Exception): pass",
    "class SessionRevokedError(Exception): pass",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(modules, "telethon", "__init__.py"), [
    "from .sessions import StringSession",
    "class User:",
    "    first_name, last_name, username = 'Account', 'A', None",
    "class TelegramClient:",
    "    def __init__(self, session, *args, **kwargs): self.session = session",
    "    async def connect(self):",
    "        from telegram_mcp import singleton",
    "        if not singleton.LOCKED: raise RuntimeError('session lock missing')",
    "    async def is_user_authorized(self): return True",
    "    async def get_me(self): return User()",
    "    async def log_out(self): return True",
    "    async def disconnect(self): pass",
    "",
  ].join("\n"));
  const result = Bun.spawnSync({
    cmd: [python!, path.resolve(import.meta.dir, "..", "..", "..", "bin", "telegram-login-bridge.py"), "health"],
    env: {
      ...process.env,
      PYTHONPATH: modules,
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
    },
    stdin: Buffer.from(`${JSON.stringify({ session: "1ApWapzMBu4placeholder-not-a-real-session" })}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ event: "health", status: "connected" });

  const logout = Bun.spawnSync({
    cmd: [python!, path.resolve(import.meta.dir, "..", "..", "..", "bin", "telegram-login-bridge.py"), "logout"],
    env: {
      ...process.env,
      PYTHONPATH: modules,
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
    },
    stdin: Buffer.from(`${JSON.stringify({ session: "1ApWapzMBu4placeholder-not-a-real-session" })}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(logout.exitCode).toBe(0);
  expect(JSON.parse(logout.stdout.toString())).toMatchObject({ event: "logout", ok: true });
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
