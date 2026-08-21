import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-runner-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { TelegramReportRunner, RUN_TIMEOUT_MS } = await import("./reportRunner");
const { readTelegramReports, readReportText, reportInboxPath, updateTelegramReports } = await import("./reportStore");
const { DAILY_REPORT_TAG } = await import("./reportPrompt");

import type { ReportRunnerPorts } from "./reportRunner";
import type { StoredTelegramConnection } from "./sessionStore";
import type { TelegramChatSummary, TelegramReadPort } from "./reportSources";

const NOW = Date.parse("2026-08-21T07:00:00.000Z"); // 10:00 Kyiv, Friday
const IDENTITY = { name: "Account A", username: "account_a" };

const CONNECTED: StoredTelegramConnection = {
  version: 1,
  status: "connected",
  credentialRef: "credential-ref-placeholder",
  identity: IDENTITY,
  lastHealthCheckAt: "2026-08-21T06:59:00.000Z",
  errorCode: null,
};

class FakePorts implements ReportRunnerPorts {
  clock = NOW;
  connectionState: StoredTelegramConnection = { ...CONNECTED };
  chats: TelegramChatSummary[] = [{ id: "101", kind: "user", title: "Dialog A", username: null, unread: 2 }];
  lastMessage: string | null = "2026-08-21T05:00:00.000Z";
  listChatsError: Error | null = null;
  /** Holds the source pass open, to model a run still being planned. */
  listChatsGate: Promise<void> | null = null;
  spawns: Record<string, unknown>[] = [];
  spawnResult: { status: number; body: Record<string, unknown> } = {
    status: 202,
    body: { conversationId: "conversation_report", launchId: "launch_report", ok: true },
  };
  live = true;
  logs: string[] = [];
  now() { return this.clock; }
  connection() { return this.connectionState; }
  readPort(): TelegramReadPort {
    return {
      listChats: async () => {
        if (this.listChatsGate) await this.listChatsGate;
        if (this.listChatsError) throw this.listChatsError;
        return this.chats;
      },
      lastMessageAt: async () => this.lastMessage,
    };
  }
  async spawn(body: Record<string, unknown>) {
    this.spawns.push(body);
    return this.spawnResult;
  }
  async conversationLive() { return this.live; }
  log(message: string) { this.logs.push(message); }
}

function activeRunId(): string {
  const active = readTelegramReports().active;
  if (!active) throw new Error("no active run");
  return active.runId;
}

/** What the launched agent does: write its report to the inbox path. */
function agentWrites(text: string): void {
  fs.writeFileSync(reportInboxPath(activeRunId()), text, { mode: 0o644 });
}

function enableReports(): void {
  updateTelegramReports((state) => { state.settings.enabled = true; });
}

beforeEach(() => {
  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

test("Run now launches a board-visible Codex conversation holding exactly viewer + telegram", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  const launched = await runner.runNow();
  /* Run now returns as soon as the run exists; the source pass and the launch
     continue behind it. */
  expect(launched).toEqual({ ok: true, runId: activeRunId() });
  expect(runner.payload().history[0].status).toBe("running");
  await runner.settled();
  expect(readTelegramReports().active?.conversationId).toBe("conversation_report");
  expect(ports.spawns.length).toBe(1);
  const body = ports.spawns[0];
  expect(body.mcpServers).toEqual(["viewer", "telegram"]);
  expect(body.engine).toBe("codex");
  /* No role and no parent: a role preset or a lineage parent would classify
     the launch as delegated and strip the grant. */
  expect(body.role).toBeUndefined();
  expect(body.parentConversationId).toBeUndefined();
  expect(String(body.cwd)).toContain("report-workspace");

  const prompt = String(body.prompt);
  expect(prompt).toContain("get_me");
  expect(prompt).toContain("@account_a");
  expect(prompt).toContain(`run-${launched.ok ? launched.runId : ""}.sources.json`);
  expect(prompt).toContain(reportInboxPath(activeRunId()));
  /* The private dialogs to read travel in the owner-only plan file, never in
     the prompt the transcript and the registry keep. */
  expect(prompt).not.toContain("Dialog A");
  expect(prompt).not.toContain("101");

  const plan = JSON.parse(fs.readFileSync(path.join(SANDBOX, "state", "telegram", `run-${activeRunId()}.sources.json`), "utf8")) as { privateDialogs: { id: string }[] };
  expect(plan.privateDialogs.map((row) => row.id)).toEqual(["101"]);

  /* The live run is visible as a row while it works. */
  expect(runner.payload().history[0].status).toBe("running");
});

test("a report is stored, the row reads ok, and the window advances", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  agentWrites(`${DAILY_REPORT_TAG}\n⏳ Awaiting your reply\n[1] Contact A asked about the schedule and has waited 6 hours.\n`);
  ports.clock = NOW + 5 * 60_000;
  await runner.tick();

  const file = readTelegramReports();
  expect(file.active).toBeNull();
  expect(file.history[0]).toMatchObject({ id: runId, status: "ok", hasReport: true, trigger: "manual", errorCode: null });
  expect(readReportText(runId)).toContain("[1] Contact A asked");
  expect(file.cursor.lastSuccessfulWindowEndAt).toBe(file.history[0].windowEnd);
});

test("an empty window reads QUIET and keeps no report body", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  agentWrites(`${DAILY_REPORT_TAG}\nQUIET\n`);
  await runner.tick();

  const file = readTelegramReports();
  expect(file.history[0]).toMatchObject({ status: "quiet", hasReport: false });
  expect(readReportText(runId)).toBeNull();
  /* A quiet day still covered the window. */
  expect(file.cursor.lastSuccessfulWindowEndAt).toBe(file.history[0].windowEnd);
});

test("a get_me mismatch ends the run with no report and no window advance", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  agentWrites(`${DAILY_REPORT_TAG}\nACCOUNT-MISMATCH\n`);
  await runner.tick();

  const file = readTelegramReports();
  expect(file.history[0]).toMatchObject({ status: "account-mismatch", hasReport: false });
  expect(readReportText(runId)).toBeNull();
  expect(file.cursor.lastSuccessfulWindowEndAt).toBeNull();
});

test("a run whose conversation dies mid-read fails retryably, and the next run covers the missed window", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  /* The connector crashed and took the turn with it: the conversation is
     terminal and nothing was written. */
  ports.live = false;
  ports.clock = NOW + 4 * 60_000;
  await runner.tick();

  const failed = readTelegramReports();
  expect(failed.history[0]).toMatchObject({ status: "failed", errorCode: "run_ended_without_report", hasReport: false });
  expect(failed.cursor.lastSuccessfulWindowEndAt).toBeNull();

  /* The retry a day later still starts 24 h before the FAILED run, not 24 h
     before the retry — the window the failure did not cover is still owed. */
  ports.live = true;
  ports.clock = NOW + 24 * 3_600_000;
  await runner.runNow();
  await runner.settled();
  const retry = readTelegramReports().active!;
  expect(Date.parse(retry.windowStart)).toBe(ports.clock - 24 * 3_600_000);
  expect(Date.parse(retry.windowEnd)).toBe(ports.clock);
});

test("a run that produces nothing at all times out into a failed row", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  ports.clock = NOW + RUN_TIMEOUT_MS + 1;
  await runner.tick();
  expect(readTelegramReports().history[0]).toMatchObject({ status: "failed", errorCode: "timed_out" });
});

test("a connector that cannot list chats fails the run before anything is launched", async () => {
  const ports = new FakePorts();
  ports.listChatsError = new Error("connector restarting");
  enableReports();
  const runner = new TelegramReportRunner(ports);
  const launched = await runner.runNow();
  await runner.settled();

  expect(launched.ok).toBe(true);
  expect(ports.spawns.length).toBe(0);
  const file = readTelegramReports();
  expect(file.active).toBeNull();
  expect(file.history[0]).toMatchObject({ status: "failed", errorCode: "sources_failed" });
});

test("a disconnected account cannot run a report, and its stored reports are cleared", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  agentWrites(`${DAILY_REPORT_TAG}\nbody kept for the moment\n`);
  await runner.tick();
  expect(readTelegramReports().history.length).toBe(1);

  /* Log out / delete local session: no status, no credential. */
  ports.connectionState = { version: 1, status: "disconnected", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: null };
  await runner.tick();
  const cleared = readTelegramReports();
  expect(cleared.history).toEqual([]);
  expect(cleared.settings.enabled).toBe(false);
  expect(runner.grantActive()).toBe(false);

  const refused = await runner.runNow();
  expect(refused).toEqual({ ok: false, code: "reports_disabled" });
});

test("the scheduled run fires once a day, and a Viewer restart catches up a missed slot", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);

  ports.clock = Date.parse("2026-08-21T06:30:00.000Z"); // 09:30 Kyiv — before the slot
  await runner.tick();
  expect(ports.spawns.length).toBe(0);

  ports.clock = NOW; // 10:00 Kyiv
  await runner.tick();
  expect(ports.spawns.length).toBe(1);
  agentWrites(`${DAILY_REPORT_TAG}\nQUIET\n`);
  await runner.tick();
  /* Second tick the same day settles the run and launches nothing new. */
  expect(ports.spawns.length).toBe(1);

  ports.clock = NOW + 3 * 3_600_000;
  await runner.tick();
  expect(ports.spawns.length).toBe(1);

  /* The Viewer is restarted the next day, hours after the slot: a fresh
     runner over the same durable state owes the day a run. */
  const afterRestart = new TelegramReportRunner(ports);
  ports.clock = NOW + 24 * 3_600_000 + 5 * 3_600_000;
  await afterRestart.tick();
  expect(ports.spawns.length).toBe(2);
  expect(readTelegramReports().history.length).toBe(1);
  expect(afterRestart.payload().history[0].status).toBe("running");
});

test("a rejected launch is a visible failed row, not silence", async () => {
  const ports = new FakePorts();
  ports.spawnResult = { status: 400, body: { error: "spawn refused" } };
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  expect(readTelegramReports().history[0]).toMatchObject({ status: "failed", errorCode: "launch_failed", conversationId: null });
});

test("a successful Run now after the slot satisfies the day; one before it does not", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);

  /* 10:05 Kyiv: the operator asked for the report five minutes late, so the
     scheduler must not deliver a second one for the same day. */
  ports.clock = NOW + 5 * 60_000;
  await runner.runNow();
  await runner.settled();
  agentWrites(`${DAILY_REPORT_TAG}\nQUIET\n`);
  await runner.tick();
  expect(ports.spawns.length).toBe(1);
  expect(readTelegramReports().cursor.lastScheduledDay).toBe("2026-08-21");

  /* Next morning at 09:00 Kyiv, before the slot: this run does not consume
     the day, and the 10:00 report still arrives. */
  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
  enableReports();
  const early = new TelegramReportRunner(ports);
  ports.clock = Date.parse("2026-08-21T06:00:00.000Z");
  await early.runNow();
  await early.settled();
  agentWrites(`${DAILY_REPORT_TAG}\nQUIET\n`);
  await early.tick();
  expect(readTelegramReports().cursor.lastScheduledDay).toBeNull();
  ports.clock = NOW;
  await early.tick();
  expect(readTelegramReports().active).not.toBeNull();
});

test("a settled run leaves its source plan behind on disk in no case", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  const sources = path.join(SANDBOX, "state", "telegram", `run-${runId}.sources.json`);
  expect(fs.existsSync(sources)).toBe(true);
  agentWrites(`${DAILY_REPORT_TAG}\n⏳ Awaiting your reply\n[1] Contact A asked about the schedule.\n`);
  await runner.tick();
  /* The plan names the operator's private dialogs; the report it produced is
     the only thing that outlives the run. */
  expect(fs.existsSync(sources)).toBe(false);
  expect(readReportText(runId)).toContain("[1] Contact A");
});

test("a run orphaned mid-source-pass by a restart is settled, never left hanging", async () => {
  const ports = new FakePorts();
  enableReports();
  let release: () => void = () => {};
  ports.listChatsGate = new Promise<void>((resolve) => { release = resolve; });

  const before = new TelegramReportRunner(ports);
  const started = await before.runNow();
  expect(started.ok).toBe(true);
  /* The row exists and reads running while the sources are being planned. */
  expect(readTelegramReports().active?.conversationId).toBeNull();
  expect(before.payload().history[0].status).toBe("running");

  /* The Viewer restarts: a fresh runner finds an active row no process is
     planning, and settles it instead of leaving the panel stuck on running. */
  const afterRestart = new TelegramReportRunner(ports);
  ports.clock = NOW + 60_000;
  /* Today's scheduled slot is already accounted for, so this tick does
     nothing but reconcile the orphan. */
  updateTelegramReports((state) => { state.cursor.lastScheduledDay = "2026-08-21"; });
  await afterRestart.tick();
  const file = readTelegramReports();
  expect(file.active).toBeNull();
  expect(file.history.some((row) => row.status === "failed" && row.errorCode === "launch_failed")).toBe(true);

  release();
  await before.settled();
  /* The planner that woke up to a settled run launched nothing. */
  expect(ports.spawns.length).toBe(0);
});

test("a second Run now while one is live is refused rather than doubling the reads", async () => {
  const ports = new FakePorts();
  enableReports();
  let release: () => void = () => {};
  ports.listChatsGate = new Promise<void>((resolve) => { release = resolve; });
  const runner = new TelegramReportRunner(ports);
  expect((await runner.runNow()).ok).toBe(true);
  expect(await runner.runNow()).toEqual({ ok: false, code: "run_in_progress" });
  release();
  await runner.settled();
  expect(ports.spawns.length).toBe(1);
});
