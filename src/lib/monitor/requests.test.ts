import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Isolated state before any module bakes a statePath(). Nothing in this file
   touches the shared registry. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-requests-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { MONITOR_MARKER, isMonitorAuthored, operatorRequestsFrom, requestFingerprint } = await import("./requests");
type SessionRecordLike = Parameters<typeof operatorRequestsFrom>[0][number];

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  /* Restore the ambient environment: the next test file in the same process
     resolves its own sandbox through os.tmpdir(). */
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const WINDOW = { fromMs: Date.parse("2026-07-26T00:00:00Z"), toMs: Date.parse("2026-07-27T00:00:00Z") };
const SCOPE = "viewer";

function userMessage(text: string, ts = "2026-07-26T10:00:00Z"): SessionRecordLike {
  return { kind: "message", role: "user", ts, text };
}

describe("operator request extraction", () => {
  test("keeps an operator request and drops assistant text, reasoning and tool output", () => {
    const requests = operatorRequestsFrom(
      [
        userMessage("Please add a retry to the deploy script when the health check flaps."),
        { kind: "message", role: "assistant", ts: "2026-07-26T10:01:00Z", text: "Sure, I will add a retry to the deploy script." },
        { kind: "reasoning", role: "assistant", ts: "2026-07-26T10:01:30Z", text: "The user wants me to fix the deploy script retry." },
        { kind: "tool_result", role: "tool", ts: "2026-07-26T10:02:00Z", text: "create a file at the deploy script path" },
      ],
      SCOPE,
      WINDOW,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.title.toLowerCase()).toContain("retry");
    expect(requests[0]!.project).toBe("viewer");
  });

  test("never mistakes the monitor's own nudge for an operator request", () => {
    const nudge = `${MONITOR_MARKER} run 2026-07-26T09:00:00Z\n\nUntracked: create a retry for the deploy script. Please review and delegate.`;
    expect(isMonitorAuthored(nudge)).toBe(true);
    const requests = operatorRequestsFrom([userMessage(nudge)], SCOPE, WINDOW);
    expect(requests).toHaveLength(0);
  });

  test("drops injected context, harness service prompts and chatter", () => {
    const requests = operatorRequestsFrom(
      [
        userMessage("<system-reminder>As you answer, use this context: create a task for everything.</system-reminder>"),
        userMessage("Caveat: this message was auto-generated, please create the follow-up card."),
        userMessage("[Request interrupted by user]"),
        userMessage("ok"),
        userMessage("thanks, looks good"),
      ],
      SCOPE,
      WINDOW,
    );
    expect(requests).toHaveLength(0);
  });

  test("bounds the window on both ends and needs a timestamp", () => {
    const requests = operatorRequestsFrom(
      [
        userMessage("Please implement the audit journal rotation.", "2026-07-25T10:00:00Z"),
        userMessage("Please implement the board card budget.", "2026-07-28T10:00:00Z"),
        { kind: "message", role: "user", ts: null, text: "Please implement the retry budget for delivery." },
        userMessage("Please implement the stall threshold override.", "2026-07-26T12:00:00Z"),
      ],
      SCOPE,
      WINDOW,
    );
    expect(requests.map((request) => request.title)).toHaveLength(1);
    expect(requests[0]!.title.toLowerCase()).toContain("stall threshold");
  });

  test("fingerprints are stable across wording noise and unique across requests", () => {
    const first = requestFingerprint("Please  fix the DEPLOY retry!!");
    const second = requestFingerprint("please fix the deploy retry");
    expect(first).toBe(second);
    expect(first).not.toBe(requestFingerprint("please fix the board budget"));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  test("collapses a request the operator repeated inside the window", () => {
    const requests = operatorRequestsFrom(
      [
        userMessage("Please add a retry to the deploy script.", "2026-07-26T10:00:00Z"),
        userMessage("please add a retry to the deploy script", "2026-07-26T18:00:00Z"),
      ],
      SCOPE,
      WINDOW,
    );
    expect(requests).toHaveLength(1);
    /* The earliest instant is what the request is dated by — that is when the
       operator actually asked. */
    expect(requests[0]!.at).toBe("2026-07-26T10:00:00.000Z");
  });

  test("captures explicit issue references and a GitHub-issue ask", () => {
    const requests = operatorRequestsFrom(
      [userMessage("Please create a GitHub issue for the flaky deploy retry, similar to #741.")],
      SCOPE,
      WINDOW,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.references).toEqual([741]);
    expect(requests[0]!.asksForGithubIssue).toBe(true);
  });

  test("redacts secrets and absolute home paths out of the captured text", () => {
    /* Assembled at runtime rather than written out: a literal key shape in a
       committed file is exactly what the publication gate exists to reject,
       and the redactor sees the same string either way. */
    const secret = ["sk", "ant", "abcdefghijklmnopqrst"].join("-");
    const requests = operatorRequestsFrom(
      [userMessage(`Please fix the token load in ${SANDBOX}/deploy.env, it reads ${secret} now.`)],
      SCOPE,
      WINDOW,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).not.toContain(SANDBOX);
    expect(requests[0]!.text).not.toContain(secret);
    expect(requests[0]!.text).toContain("[redacted]");
  });
});
