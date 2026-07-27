import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-gh-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { githubEvidenceSource } = await import("./githubEvidence");
const { evidenceFromGithub } = await import("./evidence");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("github evidence", () => {
  test("reads pull requests and issues, and never writes", async () => {
    const invocations: string[][] = [];
    const source = githubEvidenceSource({
      cwd: SANDBOX,
      run: async (args) => {
        invocations.push(args);
        return args[0] === "pr"
          ? JSON.stringify([{ number: 737, title: "pipeline engine split", state: "OPEN", updatedAt: "2026-07-26T10:00:00Z" }])
          : JSON.stringify([{ number: 741, title: "recurring conversation monitor", state: "CLOSED", updatedAt: "2026-07-27T10:00:00Z" }]);
      },
    });
    const rows = await source();
    expect(rows.map((row) => row.number)).toEqual([737, 741]);
    expect(invocations.every((args) => args[1] === "list")).toBe(true);
    expect(invocations.flat()).not.toContain("create");

    const evidence = evidenceFromGithub(rows);
    expect(evidence[0]!.state).toBe("active");
    expect(evidence[1]!.state).toBe("terminal");
    expect(evidence[1]!.references).toEqual([741]);
  });

  test("garbage output is an error the run can degrade on, not a silent empty list", async () => {
    const source = githubEvidenceSource({ cwd: SANDBOX, run: async () => "not json" });
    expect(source()).rejects.toThrow(/parsable JSON/);
  });

  test("skips rows without a usable number", async () => {
    const source = githubEvidenceSource({ cwd: SANDBOX, run: async () => JSON.stringify([{ title: "no number" }, { number: 12, title: "ok", state: "OPEN" }]) });
    const rows = await source();
    expect(rows.map((row) => row.number)).toEqual([12, 12]);
  });
});
