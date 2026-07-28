import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-redact-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { redactBounded, redactMonitorText } = await import("./redact");

/** Path and address fixtures, built at runtime so this file carries none. */
const abs = (...segments: string[]): string => `/${segments.join("/")}`;
const AT = String.fromCharCode(64);

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("monitor redaction", () => {
  test("removes email addresses in every ordinary shape", () => {
    /* Fixtures are assembled at runtime throughout this file: a literal address
       or home path in a committed file is itself a publication finding, and the
       redactor sees the same string either way. */
    const dotted = ["person.name+tag", "example.co.uk"].join(AT);
    const subdomain = ["someone", "sub.domain.org"].join(AT);
    const redacted = redactMonitorText(`mail ${dotted} and <${subdomain}> about it`);
    expect(redacted).not.toContain(dotted);
    expect(redacted).not.toContain(subdomain);
    expect(redacted).toContain("[redacted-email]");
  });

  test("removes the operator's own home directory", () => {
    expect(redactMonitorText(`look in ${SANDBOX}/notes.md`)).not.toContain(SANDBOX);
  });

  test("removes other people's home directories, however short", () => {
    for (const home of [abs("home", "someone"), abs("Users", "Someone"), abs("root")]) {
      const redacted = redactMonitorText(`the config sits at ${home}/x`);
      expect(redacted).not.toContain(home);
    }
  });

  test("removes SHORT absolute paths, not only deep ones", () => {
    /* Two segments is a real path and was surviving: an /etc entry names the
       machine as surely as a ten-segment path does. */
    for (const value of [abs("etc", "passwd"), abs("var", "log"), abs("opt", "agents", "state.json"), abs("srv", "data", "a", "b", "c")]) {
      expect(redactMonitorText(`see ${value} for detail`)).not.toContain(value);
    }
  });

  test("removes percent-encoded and dash-encoded path forms", () => {
    const percentEncoded = ["home", "someone", "Projects", "thing"].map((segment) => `%2F${segment}`).join("");
    expect(redactMonitorText(`open ${percentEncoded}/log.jsonl now`)).not.toContain(percentEncoded);

    const dashed = ["", "home", "someone", "Projects", "viewer"].join("-");
    expect(redactMonitorText(`the project dir is ${dashed} here`)).not.toContain(dashed);

    const dashedUsers = ["", "Users", "Someone", "code", "thing"].join("-");
    expect(redactMonitorText(`and ${dashedUsers} too`)).not.toContain(dashedUsers);
  });

  test("keeps URLs readable, and takes the cost of collapsing route-shaped text", () => {
    /* A URL is public by nature and survives whole. `/api/tasks` collapses,
       which is the accepted price of catching two-segment paths: nothing the
       monitor emits needs to name a route, and a rule with holes in it is
       worth less than a rule that occasionally over-redacts. */
    const kept = redactMonitorText(`POST https://github.com/owner/repo/pull/744 through ${abs("api", "tasks")}`);
    expect(kept).toContain("https://github.com/owner/repo/pull/744");
    expect(kept).toContain("…/tasks");
  });

  test("still removes credentials through the shared hardened redactor", () => {
    const secret = ["sk", "ant", "abcdefghijklmnopqrst"].join("-");
    expect(redactMonitorText(`token ${secret} here`)).not.toContain(secret);
  });

  test("bounds length after redaction, never before", () => {
    const secretPath = abs("etc", "passwd");
    const bounded = redactBounded(`${"a".repeat(40)} ${secretPath}`, 30);
    expect(bounded.length).toBeLessThanOrEqual(30);
    expect(bounded).not.toContain(secretPath);
  });
});
