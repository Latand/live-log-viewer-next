import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";

/* The state dir must point at a sandbox before store.ts computes its
   module-level constants, so exec/store load dynamically after the env set. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-exec-test-"));
const { forgetHeadlessReview, headlessReviewStatus, reviewerCommand, scanEventStream, startHeadlessReview } = await import("./exec");
const { reviewerPrompt } = await import("./prompts");
const { outputPathFor, stdoutPathFor } = await import("./store");

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

const EVENTS = [
  JSON.stringify({ type: "session.created", session_id: "11111111-2222-3333-4444-555555555555" }),
  "not json",
  JSON.stringify({ item: { type: "agent_message", text: "VERDICT: APPROVE\n\nLooks good." } }),
].join("\n");

function writeArtifacts(flowId: string, round: number, stdout: string, lastMessage?: string): void {
  const stdoutPath = stdoutPathFor(flowId, round);
  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
  fs.writeFileSync(stdoutPath, stdout);
  if (lastMessage !== undefined) fs.writeFileSync(outputPathFor(flowId, round), lastMessage);
}

/** A real detached process, as startHeadlessReview would leave behind. */
function spawnSleeper(): number {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

async function waitForDeath(pid: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} refused to die`);
}

async function waitForFile(filePath: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`file ${filePath} was not created`);
}

test("scanEventStream extracts session id and last agent message", () => {
  const scanned = scanEventStream(EVENTS);
  expect(scanned.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  expect(scanned.lastAgentMessage).toContain("VERDICT: APPROVE");
});

test("headless codex reviewer launches without CLI sandbox blocking", () => {
  const built = reviewerCommand({ engine: "codex", model: null, effort: "xhigh" }, "review prompt", "/out/review.md", "/repo");

  expect(built.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(built.args).toContain("-");
  expect(built.args).not.toContain("review prompt");
  expect(built.stdin).toBe("review prompt");
  expect(built.args).not.toContain("--sandbox");
  expect(built.args).not.toContain("read-only");
});

test("headless Codex launch flushes the complete prompt and closes stdin", async () => {
  const capturePath = path.join(process.env.LLV_STATE_DIR!, "stdin-capture.json");
  const executablePath = path.join(process.env.LLV_STATE_DIR!, "fake-codex");
  const prompt = "Review line one.\nReview line two with unicode: Привіт.\n";
  fs.writeFileSync(
    executablePath,
    `#!${process.execPath}\nconst prompt = await Bun.stdin.text();\nawait Bun.write(${JSON.stringify(capturePath)}, JSON.stringify({ prompt, eof: true }));\n`,
    { mode: 0o700 },
  );

  startHeadlessReview(
    "flow-stdin-eof",
    1,
    { engine: "codex", model: null, effort: null },
    process.cwd(),
    prompt,
    5_000,
    null,
    null,
    { command: executablePath },
  );
  await waitForFile(capturePath);

  expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({ prompt, eof: true });
  forgetHeadlessReview("flow-stdin-eof", 1);
});

test("headless managed Codex reviewer fixes its account home and file credential store at launch", () => {
  const built = reviewerCommand(
    { engine: "codex", model: null, effort: null },
    "review prompt",
    "/out/review.md",
    "/repo",
    { home: "/accounts/work", managed: true },
  );

  expect(built.env.CODEX_HOME).toBe("/accounts/work");
  expect(built.args).toContain("cli_auth_credentials_store=file");
});

test("headless claude reviewer launches with approval-free tool access", () => {
  const built = reviewerCommand({ engine: "claude", model: null, effort: null }, "review prompt", "/out/review.md", "/repo");

  expect(built.args).toContain("--dangerously-skip-permissions");
  expect(built.args).not.toContain("--permission-mode");
  expect(built.args).not.toContain("--disallowedTools");
});

test("reviewer prompt carries the read-only contract while allowing validation commands", () => {
  const prompt = reviewerPrompt(
    {
      id: "flow-a",
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: "/sessions/implementer.jsonl",
      roles: {
        implementer: { engine: "codex", model: null, effort: null },
        reviewer: { engine: "codex", model: null, effort: null },
      },
      baseRef: "abc123",
      baseMode: "head",
      mode: "auto",
      reviewerMode: "headless",
      roundLimit: 5,
      state: "reviewing",
      pausedState: null,
      stateDetail: null,
      rounds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      closedAt: null,
    },
    {
      n: 1,
      reviewerPath: null,
      sessionId: null,
      reviewerPid: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: "tests are green",
      verdict: null,
      findingsCount: null,
      startedAt: "2026-01-01T00:01:00.000Z",
      spawnStartedAt: null,
      relayStartedAt: null,
      reviewedAt: null,
      relayedAt: null,
      error: null,
    },
  );

  expect(prompt).toContain("run tests, builds, linters, searches");
  expect(prompt).toContain("Do not edit files");
});

test("status is null when the round never left a trace", () => {
  expect(headlessReviewStatus("flow-a", 1, { reviewerPid: null, spawnStartedAt: null }, "codex")).toBeNull();
});

test("restart reconstruction: alive pid reports running, dead pid yields the artifact verdict", async () => {
  const pid = spawnSleeper();
  writeArtifacts("flow-b", 1, EVENTS);
  const round = { reviewerPid: pid, reviewerIdentity: procBackend.processIdentity(pid), spawnStartedAt: new Date().toISOString() };

  const running = headlessReviewStatus("flow-b", 1, round, "codex");
  expect(running?.status).toBe("running");
  expect(running?.sessionId).toBe("11111111-2222-3333-4444-555555555555");

  process.kill(pid, "SIGKILL");
  await waitForDeath(pid);
  fs.writeFileSync(outputPathFor("flow-b", 1), "VERDICT: APPROVE\n\nShip it.");
  const done = headlessReviewStatus("flow-b", 1, round, "codex");
  expect(done?.status).toBe("done");
  expect(done?.finalOutput).toBe("VERDICT: APPROVE\n\nShip it.");
});

test("restart reconstruction rejects a live pid whose process identity changed", () => {
  const pid = spawnSleeper();
  try {
    const status = headlessReviewStatus("flow-reused", 1, {
      reviewerPid: pid,
      reviewerIdentity: `${pid}:stale`,
      spawnStartedAt: new Date().toISOString(),
    }, "codex");
    expect(status?.status).not.toBe("running");
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("cancel leaves a reused persisted reviewer pid untouched", () => {
  const pid = spawnSleeper();
  try {
    forgetHeadlessReview("flow-cancel-reused", 1, { reviewerPid: pid, reviewerIdentity: `${pid}:stale` });
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("restart reconstruction: dead codex run without artifact falls back to the event-stream message", async () => {
  const pid = spawnSleeper();
  writeArtifacts("flow-c", 2, EVENTS);
  process.kill(pid, "SIGKILL");
  await waitForDeath(pid);
  const status = headlessReviewStatus("flow-c", 2, { reviewerPid: pid, reviewerIdentity: procBackend.processIdentity(pid), spawnStartedAt: new Date().toISOString() }, "codex");
  expect(status?.status).toBe("done");
  expect(status?.finalOutput).toContain("VERDICT: APPROVE");
});

test("restart reconstruction: claude reviewer's verdict is its captured stdout", () => {
  writeArtifacts("flow-d", 1, "VERDICT: REQUEST_CHANGES\n\n- fix the thing\n");
  const status = headlessReviewStatus("flow-d", 1, { reviewerPid: 999_999_999, reviewerIdentity: "999999999:gone", spawnStartedAt: new Date().toISOString() }, "claude");
  expect(status?.status).toBe("done");
  expect(status?.finalOutput).toBe("VERDICT: REQUEST_CHANGES\n\n- fix the thing");
});

test("restart reconstruction: dead run with no output at all times out past the budget", () => {
  writeArtifacts("flow-e", 1, "");
  const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const status = headlessReviewStatus("flow-e", 1, { reviewerPid: 999_999_999, reviewerIdentity: "999999999:gone", spawnStartedAt: started }, "codex");
  expect(status?.status).toBe("timeout");
});
