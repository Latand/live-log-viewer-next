import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "capture-issue-977-orchestrator-panel.ts");

function runCapture(sandbox: string, captureDir: string) {
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
  fs.mkdirSync(sanctionedTemp, { recursive: true });

  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      NODE_ENV: "test",
      PATH: "",
      HOME: path.join(sandbox, "home"),
      TMPDIR: sanctionedTemp,
      XDG_CONFIG_HOME: path.join(sandbox, "xdg"),
      LLV_STATE_DIR: path.join(sandbox, "state"),
      NEXT_TELEMETRY_DISABLED: "1",
      CHROME_BIN: path.join(sandbox, "missing-browser"),
      ORCH_CAPTURE_DIR: captureDir,
    },
  });
}

test("refusal preserves an outside override and does not fall back to clearing the default", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-refusal-"));
  const fixture = path.join(sandbox, "outside-temp", "llv-issue-977-operator-data");
  const sentinel = path.join(fixture, "keep.txt");
  const defaultSentinel = path.join(sandbox, "sanctioned-temp", "llv-issue-977", "keep-default.txt");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(path.dirname(defaultSentinel), { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");
  fs.writeFileSync(defaultSentinel, "keep-default", "utf8");

  try {
    const result = runCapture(sandbox, fixture);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    expect(fs.readFileSync(defaultSentinel, "utf8")).toBe("keep-default");
    expect(result.stderr).toContain(fixture);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("refusal resolves a temp-root symlink and preserves its outside target", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-symlink-"));
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
  const target = path.join(sandbox, "outside-temp", "operator-data");
  const sentinel = path.join(target, "keep.txt");
  const override = path.join(sanctionedTemp, "llv-issue-977-linked");
  fs.mkdirSync(sanctionedTemp, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");
  fs.symlinkSync(target, override, "dir");

  try {
    const result = runCapture(sandbox, override);

    expect(result.status).not.toBe(0);
    expect(fs.lstatSync(override).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    expect(result.stderr).toContain(override);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an accepted override remains intact and receives a fresh capture-owned child", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-accepted-"));
  const override = path.join(sandbox, "sanctioned-temp", "llv-issue-977-operator");
  const sentinel = path.join(override, "keep.txt");
  fs.mkdirSync(override, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");

  try {
    runCapture(sandbox, override);

    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    const runs = fs.readdirSync(override).filter((entry) =>
      fs.lstatSync(path.join(override, entry)).isDirectory());
    const latest = path.join(override, "llv-issue-977-latest");
    expect(runs).toHaveLength(1);
    expect(fs.statSync(path.join(override, runs[0], "home")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(override, runs[0], "out")).isDirectory()).toBe(true);
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(latest)).toBe(path.join(override, runs[0]));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an empty override behaves as unset and publishes the default latest link", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-empty-"));
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");

  try {
    runCapture(sandbox, "");

    const latest = path.join(sanctionedTemp, "llv-issue-977-latest");
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    const run = fs.realpathSync(latest);
    expect(path.dirname(run)).toBe(fs.realpathSync(sanctionedTemp));
    expect(fs.statSync(path.join(run, "out")).isDirectory()).toBe(true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
