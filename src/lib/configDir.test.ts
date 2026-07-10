import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-configdir-test-"));
const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_CACHE = process.env.XDG_CACHE_HOME;
const REAL_STATE = process.env.LLV_STATE_DIR;

const { cacheEntryPath, configFilePath, inboxDir, migrateLegacyDir, stateDir, statePath } = await import("./configDir");

afterAll(() => {
  if (REAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = REAL_XDG;
  else delete process.env.XDG_CONFIG_HOME;
  if (REAL_CACHE !== undefined) process.env.XDG_CACHE_HOME = REAL_CACHE;
  else delete process.env.XDG_CACHE_HOME;
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("LLV_STATE_DIR overrides the state dir wholesale", () => {
  process.env.LLV_STATE_DIR = path.join(SANDBOX, "custom-state");
  expect(stateDir()).toBe(path.join(SANDBOX, "custom-state"));
  expect(statePath("flows", "artifact.md")).toBe(path.join(SANDBOX, "custom-state", "flows", "artifact.md"));
  delete process.env.LLV_STATE_DIR;
});

test("state and inbox live under the agent-log-viewer config dir", () => {
  const xdg = path.join(SANDBOX, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.LLV_STATE_DIR;
  /* Pre-settled targets (sentinel planted): the resolution is under test
     here, and a settled dir keeps the migration from touching the machine's
     real legacy state. */
  for (const name of ["state", "inbox"]) {
    fs.mkdirSync(path.join(xdg, "agent-log-viewer", name), { recursive: true });
    fs.writeFileSync(path.join(xdg, "agent-log-viewer", name, ".migrated-from-legacy"), "test\n");
  }
  expect(stateDir()).toBe(path.join(xdg, "agent-log-viewer", "state"));
  expect(inboxDir()).toBe(path.join(xdg, "agent-log-viewer", "inbox"));
});

test("legacy config and cache paths remain active when the current entries are absent", () => {
  const configRoot = path.join(SANDBOX, "legacy-paths-config");
  const cacheRoot = path.join(SANDBOX, "legacy-paths-cache");
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.XDG_CACHE_HOME = cacheRoot;
  const legacyConfig = path.join(configRoot, "live-log-viewer", "transcribe-backend");
  const legacyCache = path.join(cacheRoot, "live-log-viewer", "whisper-venv");
  fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
  fs.mkdirSync(legacyCache, { recursive: true });
  fs.writeFileSync(legacyConfig, "local\n");

  expect(configFilePath("transcribe-backend")).toBe(legacyConfig);
  expect(cacheEntryPath("whisper-venv")).toBe(legacyCache);
  fs.writeFileSync(configFilePath("transcribe-backend"), "chatgpt\n");
  expect(fs.readFileSync(legacyConfig, "utf8")).toBe("chatgpt\n");
});

test("migration copies the legacy tree once, marks completion, leaves the source in place", () => {
  const legacy = path.join(SANDBOX, "legacy-state");
  const target = path.join(SANDBOX, "new-state");
  fs.mkdirSync(path.join(legacy, "flows"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), '{"flows":[]}');
  fs.writeFileSync(path.join(legacy, "flows", "artifact.md"), "round");

  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe('{"flows":[]}');
  expect(fs.readFileSync(path.join(target, "flows", "artifact.md"), "utf8")).toBe("round");
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
  expect(fs.existsSync(path.join(legacy, "flows.json"))).toBe(true);
  /* No leftover temp dirs from the atomic copy. */
  expect(fs.readdirSync(SANDBOX).filter((name) => name.includes(".migrating."))).toEqual([]);
});

test("existing target files are never overwritten; missing legacy entries heal in", () => {
  const legacy = path.join(SANDBOX, "legacy-2");
  const target = path.join(SANDBOX, "target-2");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), "OLD");
  fs.writeFileSync(path.join(legacy, "tasks.json"), "LEGACY-TASKS");
  /* The partial-migration shape: state writes created the target and one
     file, no sentinel — an interrupted pre-sentinel run looked exactly so. */
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "flows.json"), "NEW");

  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe("NEW");
  expect(fs.readFileSync(path.join(target, "tasks.json"), "utf8")).toBe("LEGACY-TASKS");
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
});

test("a missing legacy dir marks the fresh target as settled", () => {
  const target = path.join(SANDBOX, "target-3");
  migrateLegacyDir(target, path.join(SANDBOX, "no-such-legacy"));
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
});

test("a failed copy leaves no target and the next attempt succeeds", () => {
  const legacy = path.join(SANDBOX, "legacy-4");
  const target = path.join(SANDBOX, "target-4");
  const locked = path.join(legacy, "locked");
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, "secret.json"), "data");
  fs.writeFileSync(path.join(legacy, "flows.json"), "FLOWS");
  fs.chmodSync(locked, 0o000); // unreadable subdir makes cpSync throw mid-tree
  try {
    migrateLegacyDir(target, legacy);
    /* The atomic rename never ran: no half-filled target, no temp leftovers,
       and the failure stayed un-memoized. */
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(SANDBOX).filter((name) => name.startsWith("target-4.migrating"))).toEqual([]);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  migrateLegacyDir(target, legacy);
  expect(fs.readFileSync(path.join(target, "flows.json"), "utf8")).toBe("FLOWS");
  expect(fs.readFileSync(path.join(target, "locked", "secret.json"), "utf8")).toBe("data");
  expect(fs.existsSync(path.join(target, ".migrated-from-legacy"))).toBe(true);
});

test("a completed migration never reruns even when new files land in legacy", () => {
  const legacy = path.join(SANDBOX, "legacy-5");
  const target = path.join(SANDBOX, "target-5");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "flows.json"), "V1");
  migrateLegacyDir(target, legacy);
  fs.writeFileSync(path.join(legacy, "late.json"), "LATE");
  migrateLegacyDir(target, legacy);
  expect(fs.existsSync(path.join(target, "late.json"))).toBe(false);
});
