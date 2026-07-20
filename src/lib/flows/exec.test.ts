import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";

/* The state dir must point at a sandbox before store.ts computes its
   module-level constants, so exec/store load dynamically after the env set. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-exec-test-"));
const { forgetHeadlessReview, headlessReviewStatus, reviewerCommand, scanEventStream, startHeadlessReview, terminateHeadlessReviewerGroup } = await import("./exec");
const { reviewerPrompt } = await import("./prompts");
const { outputPathFor, stdoutPathFor } = await import("./store");
const { WAKATIME_CREDENTIAL_ENV } = await import("../wakatime/credential");

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

const EVENTS = [
  JSON.stringify({ type: "session.created", session_id: "11111111-2222-3333-4444-555555555555" }),
  "not json",
  JSON.stringify({ item: { type: "agent_message", text: "VERDICT: APPROVE\n\nLooks good." } }),
].join("\n");

test("reviewer group escalation kills a TERM-resistant child after the leader exits", () => {
  let leaderAlive = true;
  let childAlive = true;
  const timers: Array<() => void> = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  terminateHeadlessReviewerGroup(4242, "4242:start", {
    graceMs: 1,
    runtime: {
      pidAlive: () => leaderAlive,
      processIdentity: () => "4242:start",
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") leaderAlive = false;
        if (signal === "SIGKILL") childAlive = false;
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  expect(signals).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  timers[0]!();
  expect(signals).toEqual([
    { pid: -4242, signal: "SIGTERM" },
    { pid: -4242, signal: "SIGKILL" },
  ]);
  expect(childAlive).toBeFalse();
});

test("reviewer group escalation survives an exited leader owned by its live handle", () => {
  const timers: Array<() => void> = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  terminateHeadlessReviewerGroup(4343, null, {
    ownedByLiveHandle: true,
    leaderExited: true,
    runtime: {
      pidAlive: () => false,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") throw new Error("group exited");
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    },
  });

  timers[0]!();
  expect(signals).toEqual([
    { pid: -4343, signal: "SIGTERM" },
    { pid: -4343, signal: "SIGKILL" },
  ]);
});

test("reviewer group cleanup kills a real descendant after its detached leader exits", async () => {
  const childPidPath = path.join(process.env.LLV_STATE_DIR!, "exited-leader-child.pid");
  const leader = spawn("sh", ["-c", "(trap '' HUP TERM; while :; do sleep 1; done) & printf '%s' \"$!\" > \"$CHILD_PID_FILE\""], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CHILD_PID_FILE: childPidPath },
  });
  const leaderPid = leader.pid!;
  const leaderClosed = new Promise<void>((resolve) => { leader.once("close", () => resolve()); });

  try {
    await waitForFile(childPidPath);
    const childPid = Number(fs.readFileSync(childPidPath, "utf8"));
    await leaderClosed;
    expect(process.kill(childPid, 0)).toBeTrue();

    terminateHeadlessReviewerGroup(leaderPid, null, {
      ownedByLiveHandle: true,
      leaderExited: true,
      graceMs: 20,
    });

    await waitForDeath(childPid);
  } finally {
    try { process.kill(-leaderPid, "SIGKILL"); } catch { /* group cleanup completed */ }
  }
});

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
  expect(built.args).toContain("--ignore-user-config");
  expect(built.args).toContain("-");
  expect(built.args).not.toContain("review prompt");
  expect(built.stdin).toStartWith("review prompt");
  expect(built.args).not.toContain("--sandbox");
  expect(built.args).not.toContain("read-only");
  expect(built.args).toContain("--disable");
  expect(built.args).toContain("multi_agent");
  expect(built.stdin).toContain("review prompt");
  expect(built.stdin).toContain("Viewer spawn policy:");
});

test("headless Codex launch closes stdin and excludes the WakaTime credential from child artifacts", async () => {
  const capturePath = path.join(process.env.LLV_STATE_DIR!, "stdin-capture.json");
  const executablePath = path.join(process.env.LLV_STATE_DIR!, "fake-codex");
  const prompt = "Review line one.\nReview line two with unicode: Привіт.\n";
  const wakatimePlaceholder = ["artifact", "fixture"].join("-");
  fs.writeFileSync(
    executablePath,
    `#!${process.execPath}\nconst prompt = await Bun.stdin.text();\nawait Bun.write(${JSON.stringify(capturePath)}, JSON.stringify({ prompt, eof: true, inherited: process.env[${JSON.stringify(WAKATIME_CREDENTIAL_ENV)}] ?? null }));\n`,
    { mode: 0o700 },
  );

  Reflect.deleteProperty(process.env, WAKATIME_CREDENTIAL_ENV);
  Reflect.set(process.env, WAKATIME_CREDENTIAL_ENV, wakatimePlaceholder);
  try {
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

    const artifact = fs.readFileSync(capturePath, "utf8");
    const captured = JSON.parse(artifact) as { prompt: string; eof: boolean; inherited: string | null };
    expect(captured.prompt).toStartWith(prompt.trim());
    expect(captured.prompt).toContain("Viewer spawn policy:");
    expect(captured.eof).toBe(true);
    expect(captured.inherited).toBeNull();
    expect(artifact).not.toContain(wakatimePlaceholder);
  } finally {
    forgetHeadlessReview("flow-stdin-eof", 1);
    Reflect.deleteProperty(process.env, WAKATIME_CREDENTIAL_ENV);
  }
});

test("an owned reviewer stays running when process identity is briefly unavailable at spawn", async () => {
  const executablePath = path.join(process.env.LLV_STATE_DIR!, "fake-long-codex");
  fs.writeFileSync(
    executablePath,
    `#!${process.execPath}\nawait Bun.stdin.text();\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-2222-3333-4444-555555555556" }));\nsetInterval(() => {}, 1_000);\n`,
    { mode: 0o700 },
  );
  let identityReads = 0;
  const launched = startHeadlessReview(
    "flow-delayed-identity",
    1,
    { engine: "codex", model: null, effort: null },
    process.cwd(),
    "review prompt",
    5_000,
    null,
    null,
    {
      command: executablePath,
      processIdentity: (pid) => {
        identityReads += 1;
        return identityReads === 1 ? null : procBackend.processIdentity(pid);
      },
    },
  );

  try {
    expect(launched.identity).toBeNull();
    const status = headlessReviewStatus("flow-delayed-identity", 1, {
      reviewerPid: launched.pid,
      reviewerIdentity: launched.identity,
      spawnStartedAt: new Date().toISOString(),
    }, "codex");
    expect(status?.status).toBe("running");
    expect(status?.processIdentity).toBeString();
  } finally {
    forgetHeadlessReview("flow-delayed-identity", 1, {
      reviewerPid: launched.pid,
      reviewerIdentity: launched.identity,
    });
  }
});

test("headless managed Codex reviewer fixes its account home and file credential store at launch", () => {
  process.env.LLV_TOKEN = "viewer-token";
  const wakatimePlaceholder = ["fixture", "value"].join("-");
  Reflect.deleteProperty(process.env, WAKATIME_CREDENTIAL_ENV);
  Reflect.set(process.env, WAKATIME_CREDENTIAL_ENV, wakatimePlaceholder);
  const built = reviewerCommand(
    { engine: "codex", model: null, effort: null },
    "review prompt",
    "/out/review.md",
    "/repo",
    { home: "/accounts/work", managed: true },
    null,
    "B".repeat(43),
  );

  expect(built.env.CODEX_HOME).toBe("/accounts/work");
  expect(built.args).toContain("cli_auth_credentials_store=file");
  expect(built.env.LLV_TOKEN).toBeUndefined();
  expect(built.env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
  expect(JSON.stringify({ args: built.args, env: built.env })).not.toContain(wakatimePlaceholder);
  expect(built.env.LLV_SPAWN_CAPABILITY).toBe("B".repeat(43));
  delete process.env.LLV_TOKEN;
  Reflect.deleteProperty(process.env, WAKATIME_CREDENTIAL_ENV);
});

test("headless claude reviewer launches with approval-free tool access", () => {
  const built = reviewerCommand({ engine: "claude", model: null, effort: null }, "review prompt", "/out/review.md", "/repo");

  expect(built.args).toContain("--dangerously-skip-permissions");
  expect(built.args).not.toContain("--permission-mode");
  expect(built.args).not.toContain("--disallowedTools");
});

test("headless managed Claude reviewer installs the native sub-agent deny profile and scrubs Viewer auth", () => {
  const home = path.join(process.env.LLV_STATE_DIR!, "headless-claude-account");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ theme: "dark" }));
  process.env.LLV_TOKEN = "viewer-token";

  const built = reviewerCommand(
    { engine: "claude", model: null, effort: null },
    "review prompt",
    "/out/review.md",
    "/repo",
    null,
    { home, projectsDir: path.join(home, "projects"), managed: true },
  );
  const settingsIndex = built.args.indexOf("--settings");
  const settingsPath = built.args[settingsIndex + 1]!;
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string }> };
  };

  expect(settingsIndex).toBeGreaterThanOrEqual(0);
  expect(settings.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent|Workflow|TeamCreate|TeamDelete|SendMessage")).toBe(true);
  expect(built.env.LLV_TOKEN).toBeUndefined();
  delete process.env.LLV_TOKEN;
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

test("a persisted launch marker without a process or artifacts reports lost tracking", () => {
  expect(headlessReviewStatus("flow-lost", 1, {
    reviewerPid: null,
    reviewerIdentity: null,
    spawnStartedAt: "2026-07-12T08:35:59.000Z",
  }, "codex")?.status).toBe("lost");
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

test("restart reconstruction parks a live persisted pid whose identity was never checkpointed", () => {
  const pid = spawnSleeper();
  try {
    writeArtifacts("flow-restart-missing-identity", 1, JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Reviewer is still investigating." },
    }));
    const status = headlessReviewStatus("flow-restart-missing-identity", 1, {
      reviewerPid: pid,
      reviewerIdentity: null,
      spawnStartedAt: new Date().toISOString(),
    }, "codex");

    expect(status?.status).toBe("lost");
    expect(status?.finalOutput).toBe("Reviewer is still investigating.");
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    process.kill(pid, "SIGKILL");
  }
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
