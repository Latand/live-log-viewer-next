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
