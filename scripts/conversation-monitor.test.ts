import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-cli-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { parseMonitorArgs } = await import("./conversation-monitor");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("conversation monitor cli", () => {
  test("defaults to the loopback viewer and a live run", () => {
    const args = parseMonitorArgs([], {}, SANDBOX);
    expect(args.baseUrl).toBe("http://127.0.0.1:8898");
    expect(args.dryRun).toBeUndefined();
    expect(args.status).toBeNull();
    expect(args.github).toBe(true);
    expect(args.repoDir).toBe(SANDBOX);
  });

  test("reads the window, scope and budgets", () => {
    const args = parseMonitorArgs(["--window-hours", "12", "--project", "viewer", "--max-cards", "3", "--stall-hours", "24", "--dry-run", "--no-github"], {}, SANDBOX);
    expect(args.windowHours).toBe(12);
    expect(args.project).toBe("viewer");
    expect(args.maxCards).toBe(3);
    expect(args.stallAfterMs).toBe(24 * 60 * 60 * 1000);
    expect(args.dryRun).toBe(true);
    expect(args.github).toBe(false);
  });

  test("honours the viewer control url from the environment", () => {
    const args = parseMonitorArgs([], { LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:8899" }, SANDBOX);
    expect(args.baseUrl).toBe("http://127.0.0.1:8899");
  });

  test("--status takes an optional count", () => {
    expect(parseMonitorArgs(["--status"], {}, SANDBOX).status).toBe(5);
    expect(parseMonitorArgs(["--status", "12"], {}, SANDBOX).status).toBe(12);
  });

  test("a malformed invocation fails loudly instead of running a half-configured sweep", () => {
    expect(() => parseMonitorArgs(["--window-hours", "0"], {}, SANDBOX)).toThrow(/positive number/);
    expect(() => parseMonitorArgs(["--nope"], {}, SANDBOX)).toThrow(/unknown flag/);
  });
});
