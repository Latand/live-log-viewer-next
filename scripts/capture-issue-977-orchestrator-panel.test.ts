import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "capture-issue-977-orchestrator-panel.ts");

test("the capture process refuses an override outside its temp root and preserves the fixture", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-refusal-"));
  const sanctionedTemp = path.join(sandbox, "sanctioned-temp");
  const fixture = path.join(sandbox, "outside-temp", "llv-issue-977-operator-data");
  const sentinel = path.join(fixture, "keep.txt");
  fs.mkdirSync(sanctionedTemp, { recursive: true });
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");

  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
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
        ORCH_CAPTURE_DIR: fixture,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(fixture);
    expect(fs.existsSync(fixture)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
