import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * The #979 capture allocates a directory before it renders anything, so the
 * property worth pinning is the one a typo'd `ORCH_CAPTURE_DIR` would violate:
 * a bad override is refused BY NAME and nothing outside the run's own fresh
 * directory is touched. The shared allocator (#996) enforces the rule; these
 * cases prove this script is wired to it — same shape as the #977 sibling's.
 *
 * The subprocess dies right after the allocation (no PATH, no browser), which
 * is exactly the window under test.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "capture-issue-979-mobile-orchestrator.ts");

function runCapture(sandbox: string, captureDir: string) {
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
  fs.mkdirSync(sanctionedTemp, { recursive: true });

  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
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

test("an override outside the temp root is refused by name, and its contents survive", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-979-refusal-"));
  const fixture = path.join(sandbox, "outside-temp", "llv-issue-979-operator-data");
  const sentinel = path.join(fixture, "keep.txt");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");

  try {
    const result = runCapture(sandbox, fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ORCH_CAPTURE_DIR");
    expect(result.stderr).toContain(fixture);
    /* Refusing is not a licence to clear anything else instead. */
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a temp-root symlink pointing outside is resolved, refused, and its target left alone", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-979-symlink-"));
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
  const target = path.join(sandbox, "outside-temp", "operator-data");
  const sentinel = path.join(target, "keep.txt");
  const override = path.join(sanctionedTemp, "llv-issue-979-linked");
  fs.mkdirSync(sanctionedTemp, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");
  fs.symlinkSync(target, override, "dir");

  try {
    const result = runCapture(sandbox, override);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ORCH_CAPTURE_DIR");
    expect(fs.lstatSync(override).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an accepted override keeps what it holds and gains one fresh run with the seeded home", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-979-accepted-"));
  const override = path.join(sandbox, "sanctioned-temp", "llv-issue-979-operator");
  const sentinel = path.join(override, "keep.txt");
  fs.mkdirSync(override, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");

  try {
    runCapture(sandbox, override);

    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    const runs = fs.readdirSync(override).filter((entry) =>
      fs.lstatSync(path.join(override, entry)).isDirectory());
    expect(runs).toHaveLength(1);
    /* The run seeded its own synthetic home and output directory — the capture
       reached its work before the missing browser stopped it. */
    expect(fs.statSync(path.join(override, runs[0]!, "home")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(override, runs[0]!, "out")).isDirectory()).toBe(true);
    const latest = path.join(override, "llv-issue-979-latest");
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(latest)).toBe(path.join(override, runs[0]!));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("no override at all lands under the temp root and publishes the latest link", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-979-default-"));
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");

  try {
    runCapture(sandbox, "");

    const latest = path.join(sanctionedTemp, "llv-issue-979-latest");
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    const run = fs.realpathSync(latest);
    expect(path.dirname(run)).toBe(fs.realpathSync(sanctionedTemp));
    expect(fs.statSync(path.join(run, "out")).isDirectory()).toBe(true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
