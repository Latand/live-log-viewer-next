import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-runner-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { TelegramReportRunner, RUN_TIMEOUT_MS } = await import("./reportRunner");
const { readTelegramReports, readReportText, reportInboxPath, updateTelegramReports } = await import("./reportStore");
const { DEFAULT_DAILY_REPORT_PROMPT } = await import("./reportPrompt");
/* The tag lives in the operator's editable brief; fixtures use a synthetic
   one, exactly as a real operator's own tag never appears in this repo. */
const DAILY_REPORT_TAG = "#report_tag";

import { mcpServersForScheduledReport } from "@/lib/agent/mcpAllowlist";

import type { ReportRunnerPorts } from "./reportRunner";
import type { ReportSpawnInput, ReportSpawnResult } from "./reportSpawn";
import type { StoredTelegramConnection } from "./sessionStore";
import type { TelegramChatSummary, TelegramReadPort } from "./reportSources";

const NOW = Date.parse("2026-08-21T07:00:00.000Z"); // 10:00 Kyiv, Friday
const IDENTITY = { name: "Account A", username: "account_a", id: "770000001" };

const CONNECTED: StoredTelegramConnection = {
  version: 1,
  status: "connected",
  credentialRef: "credential-ref-placeholder",
  identity: IDENTITY,
  lastHealthCheckAt: "2026-08-21T06:59:00.000Z",
  errorCode: null,
  identityIdUpgradedAt: null,
};

class FakePorts implements ReportRunnerPorts {
  clock = NOW;
  connectionState: StoredTelegramConnection = { ...CONNECTED };
  /** What the connector's own `get_me` answers, which is what the Viewer
      verifies the recorded identity against. */
  liveIdentity: { name: string; username: string | null; id: string | null } | null = { ...IDENTITY };
  getMeError: Error | null = null;
  chats: TelegramChatSummary[] = [{ id: "101", kind: "user", title: "Dialog A", username: null, unread: 2 }];
  /** What the connector's incoming feed recorded as active (#1091). */
  feed: Array<{ id: string; title: string; lastMessageAt: string }> = [];
  lastMessage: string | null = "2026-08-21T05:00:00.000Z";
  listChatsError: Error | null = null;
  /** Holds the source pass open, to model a run still being planned. */
  listChatsGate: Promise<void> | null = null;
  /** Every read the Viewer itself made, in order. */
  reads: string[] = [];
  spawns: Record<string, unknown>[] = [];
  /** The grant each launch was admitted with — resolved the way admission
      resolves it, by CALLING the launcher's callback. */
  grants: string[][] = [];
  spawnResult: ReportSpawnResult = {
    status: 202,
    body: { conversationId: "conversation_report", launchId: "launch_report", ok: true },
  };
  live = true;
  logs: string[] = [];
  now() { return this.clock; }
  connection() { return this.connectionState; }
  readPort(): TelegramReadPort {
    return {
      getMe: async () => {
        this.reads.push("getMe");
        if (this.getMeError) throw this.getMeError;
        return this.liveIdentity;
      },
      feedDialogs: async () => {
        this.reads.push("feedDialogs");
        return this.feed;
      },
      listChats: async () => {
        this.reads.push("listChats");
        if (this.listChatsGate) await this.listChatsGate;
        if (this.listChatsError) throw this.listChatsError;
        return this.chats;
      },
      pageChats: async () => [],
      lastMessageAt: async () => this.lastMessage,
    };
  }
  async spawn(input: ReportSpawnInput) {
    this.spawns.push(input.body);
    this.grants.push(mcpServersForScheduledReport({ grantActive: input.grantActive() }));
    return this.spawnResult;
  }
  async conversationLive() { return this.live; }
  log(code: string) { this.logs.push(code); }
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
  /* The grant is not in the body at all any more: admission resolves it from
     the report session class, through the callback the launch carries. */
  expect(body.mcpServers).toBeUndefined();
  expect(ports.grants[0]).toEqual(["viewer", "telegram"]);
  expect(body.engine).toBe("codex");
  /* No role and no parent: a role preset or a lineage parent would classify
     the launch as delegated and strip the grant. The durable link to the run
     is the attempt id instead. */
  expect(body.role).toBeUndefined();
  expect(body.parentConversationId).toBeUndefined();
  expect(body.src).toBeUndefined();
  expect(body.clientAttemptId).toBe(`telegram-report-${launched.ok ? launched.runId : ""}`);
  /* The other half of the durable marker (#1091): explicit project ownership,
     which is what the board groups the run's card by. */
  expect(body.project).toBe("telegram-reports");
  expect(String(body.cwd)).toContain("report-workspace");

  const prompt = String(body.prompt);
  /* The account was verified by the Viewer before this launch, so the recorded
     identity is in no prompt, no transcript and no registry row. */
  expect(ports.reads[0]).toBe("getMe");
  expect(prompt).not.toContain("Account A");
  expect(prompt).not.toContain("account_a");
  expect(prompt).toContain(`run-${launched.ok ? launched.runId : ""}.sources.json`);
  expect(prompt).toContain(reportInboxPath(activeRunId()));
  expect(prompt).toContain(DEFAULT_DAILY_REPORT_PROMPT.split("\n")[0]);
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

test("a get_me mismatch ends the run before any chat is read, with no report and no window advance", async () => {
  const ports = new FakePorts();
  enableReports();
  /* The connector is logged into somebody else — a re-login to a second
     account, a session swapped underneath the Viewer. */
  ports.liveIdentity = { name: "Account B", username: "account_b", id: "770000002" };
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();

  const file = readTelegramReports();
  expect(file.history[0]).toMatchObject({ status: "account-mismatch", errorCode: null, hasReport: false, conversationId: null });
  /* The Viewer performs the verification itself, so nothing was launched: no
     conversation ever held the connector, and the only read that happened was
     the account check. */
  expect(ports.spawns.length).toBe(0);
  expect(ports.reads).toEqual(["getMe"]);
  expect(file.cursor.lastSuccessfulWindowEndAt).toBeNull();
  /* The window it did not cover is still owed. */
  expect(file.cursor.unreportedSinceAt).toBe(new Date(NOW - 24 * 3_600_000).toISOString());
});

test("a pre-#1091 connection with no recorded id still reports through a rename", async () => {
  /* The name/handle rule survives for exactly one case: a connection enrolled
     before the numeric id was recorded, whose one-time migration has not run
     yet. Both recorded fields are the operator's to change at any moment and
     the recorded copy only refreshes on a health check, so demanding that both
     agree would end every report `account-mismatch` the day they picked a new
     @handle — a silently dead feature. Agreement on either field is the same
     account. */
  const legacy = { ...IDENTITY, id: null };
  const renamed = new FakePorts();
  enableReports();
  renamed.connectionState = { ...CONNECTED, identity: legacy };
  renamed.liveIdentity = { name: IDENTITY.name, username: "account_a_backup", id: IDENTITY.id };
  const afterHandleChange = new TelegramReportRunner(renamed);
  await afterHandleChange.runNow();
  await afterHandleChange.settled();
  expect(afterHandleChange.payload().history[0].status).toBe("running");
  expect(renamed.spawns.length).toBe(1);

  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
  enableReports();
  const displayName = new FakePorts();
  displayName.connectionState = { ...CONNECTED, identity: legacy };
  displayName.liveIdentity = { name: "Account A (away until Monday)", username: IDENTITY.username, id: IDENTITY.id };
  const afterNameChange = new TelegramReportRunner(displayName);
  await afterNameChange.runNow();
  await afterNameChange.settled();
  expect(displayName.spawns.length).toBe(1);
});

test("the recorded id decides: a full rename passes, a same-named stranger does not", async () => {
  /* The defect #1091 names. A second account that took the operator's display
     name and handle passed the v1 check, while the operator changing BOTH of
     their own fields failed it. The numeric id is the one field of an account
     nobody can hand themselves, so when both sides carry one it is the whole
     answer. */
  const renamed = new FakePorts();
  enableReports();
  renamed.liveIdentity = { name: "Somebody Else Entirely", username: "another_handle", id: IDENTITY.id };
  const sameAccount = new TelegramReportRunner(renamed);
  await sameAccount.runNow();
  await sameAccount.settled();
  expect(renamed.spawns.length).toBe(1);

  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
  enableReports();
  const impostor = new FakePorts();
  impostor.liveIdentity = { name: IDENTITY.name, username: IDENTITY.username, id: "770000009" };
  const otherAccount = new TelegramReportRunner(impostor);
  await otherAccount.runNow();
  await otherAccount.settled();
  expect(impostor.spawns.length).toBe(0);
  expect(impostor.reads).toEqual(["getMe"]);
  const history = otherAccount.payload().history;
  expect(history[0]).toMatchObject({ status: "account-mismatch", conversationId: null, hasReport: false });
});

test("the connector's sanitized spelling of a name is the same account", async () => {
  /* The identity recorded at Connect comes off the login bridge unsanitized,
     while every name the connector returns has been through its `sanitize_name`
     — Cc/Cf stripped, whitespace collapsed. An operator whose display name
     carries an invisible character would otherwise fail every single report
     with `account-mismatch` and have nothing to go on. */
  const ports = new FakePorts();
  enableReports();
  ports.connectionState = {
    ...CONNECTED,
    identity: { name: "Account\u200b A ", username: null, id: null },
  };
  ports.liveIdentity = { name: "Account A", username: null, id: "770000001" };
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  expect(ports.spawns.length).toBe(1);
});

test("a connection with no comparable identity fails closed", async () => {
  const ports = new FakePorts();
  enableReports();
  ports.connectionState = { ...CONNECTED, identity: null };
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  expect(readTelegramReports().history[0].status).toBe("account-mismatch");
  expect(ports.spawns.length).toBe(0);
});

test("a connector that cannot answer get_me fails the run rather than reading on", async () => {
  const ports = new FakePorts();
  enableReports();
  ports.getMeError = new Error("get_me failed for 'Account A' (@account_a) token=connector-token-value");
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();

  const file = readTelegramReports();
  expect(file.history[0]).toMatchObject({ status: "failed", errorCode: "account_check_failed" });
  expect(ports.spawns.length).toBe(0);
  expect(ports.reads).toEqual(["getMe"]);
  expect(ports.logs).toEqual(["account_check_failed"]);
  expect(file.cursor.unreportedSinceAt).toBe(new Date(NOW - 24 * 3_600_000).toISOString());
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
  /* The failure left its own window start behind as the boundary nobody has
     reported yet. */
  expect(failed.cursor.unreportedSinceAt).toBe(new Date(NOW - 24 * 3_600_000).toISOString());

  /* The retry a day later starts where the FAILED run started, not 24 h before
     the retry — the day the failure did not cover is still owed, so the retry's
     window is 48 h wide. */
  ports.live = true;
  ports.clock = NOW + 24 * 3_600_000;
  await runner.runNow();
  await runner.settled();
  const retry = readTelegramReports().active!;
  expect(Date.parse(retry.windowStart)).toBe(NOW - 24 * 3_600_000);
  expect(Date.parse(retry.windowEnd)).toBe(ports.clock);

  /* And a success clears the debt: the run after it covers only new ground. */
  agentWrites(`${DAILY_REPORT_TAG}\n👀 Worth attention — one item.\n`);
  await runner.tick();
  const settled = readTelegramReports();
  expect(settled.cursor.unreportedSinceAt).toBeNull();
  expect(settled.cursor.lastSuccessfulWindowEndAt).toBe(new Date(ports.clock).toISOString());
});

test("a failed first run never loses more than the 72 h cap", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  ports.live = false;
  ports.clock = NOW + 60_000;
  await runner.tick();
  expect(readTelegramReports().history[0].status).toBe("failed");

  /* A Viewer that was off for a week owes more than a report can usefully
     read, so the window still stops at the cap. */
  ports.live = true;
  ports.clock = NOW + 7 * 24 * 3_600_000;
  await runner.runNow();
  await runner.settled();
  const retry = readTelegramReports().active!;
  expect(Date.parse(retry.windowStart)).toBe(ports.clock - 72 * 3_600_000);
});

test("a run that writes prose instead of a report fails and keeps the window owed", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  /* No tag line: the model answered in prose instead of writing the format. */
  agentWrites("I could not read the chats, so here is a summary of what I tried.\n");
  await runner.tick();

  const file = readTelegramReports();
  expect(file.history[0]).toMatchObject({ status: "failed", errorCode: "invalid_report", hasReport: false });
  expect(readReportText(runId)).toBeNull();
  expect(file.cursor.lastSuccessfulWindowEndAt).toBeNull();
  expect(file.cursor.unreportedSinceAt).toBe(new Date(NOW - 24 * 3_600_000).toISOString());
});

test("a logout during the source pass revokes the grant the launch is admitted with", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  let release = () => {};
  ports.listChatsGate = new Promise<void>((resolve) => { release = resolve; });
  const launched = await runner.runNow();
  expect(launched.ok).toBe(true);
  /* The operator logs out while the run is still listing chats. */
  ports.connectionState = { ...CONNECTED, status: "disconnected", credentialRef: "credential-ref-placeholder", identity: null };
  release();
  await runner.settled();

  /* The launch still happened — it is a board conversation either way — but
     admission resolved the grant AFTER the logout, so it holds the baseline
     and cannot reach the connector. */
  expect(ports.spawns.length).toBe(1);
  expect(ports.grants[0]).toEqual(["viewer"]);
});

test("the runner never logs anything but a code", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  /* Everything a connector error can carry: a chat title, a handle, a token. */
  ports.listChatsError = new Error("list_chats failed for 'Dialog A' (@account_a) token=connector-token-value");
  await runner.runNow();
  await runner.settled();

  expect(readTelegramReports().history[0]).toMatchObject({ status: "failed", errorCode: "sources_failed" });
  expect(ports.logs).toEqual(["sources_failed"]);
  for (const line of ports.logs) {
    expect(line).not.toContain("Dialog A");
    expect(line).not.toContain("account_a");
    expect(line).not.toContain("connector-token-value");
  }
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
  ports.connectionState = { version: 1, status: "disconnected", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: null, identityIdUpgradedAt: null };
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

test("the run is launched with the operator's edited brief behind the fixed preamble", async () => {
  const ports = new FakePorts();
  enableReports();
  const edited = "Report in Ukrainian. First line: #report_tag. Only mention what needs an answer.";
  updateTelegramReports((state) => { state.prompt = edited; });

  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const prompt = String(ports.spawns[0].prompt);

  expect(prompt).toContain(edited);
  /* The operator's text cannot edit away the rules that keep a run correct. */
  expect(prompt).toContain("RUN RULES");
  expect(prompt).toContain("Read SEQUENTIALLY");
  expect(prompt).toContain("is NOT recency");
  expect(prompt.indexOf("RUN RULES")).toBeLessThan(prompt.indexOf(edited));
  /* And the default brief is not smuggled in beside it. */
  expect(prompt).not.toContain(DEFAULT_DAILY_REPORT_PROMPT.split("\n")[0]);
});

test("a scheduled run refused before it started still leaves its day owed", async () => {
  /* The defect this covers: `tick` stamps the day BEFORE `beginRun`, so a
     scheduled run refused at the preflight — Telegram disconnected overnight —
     consumed the slot. If the refusal also left the cursor alone, the day was
     simply gone and the next successful run started 24 h before ITSELF. */
  const ports = new FakePorts();
  enableReports();
  ports.connectionState = { ...CONNECTED, status: "expired" };
  const runner = new TelegramReportRunner(ports);
  await runner.tick();

  const refused = readTelegramReports();
  expect(refused.history[0]).toMatchObject({ status: "failed", errorCode: "not_connected", trigger: "scheduled" });
  expect(ports.spawns.length).toBe(0);
  /* The day is consumed — no retry loop every minute — but the WINDOW is not. */
  expect(refused.cursor.lastScheduledDay).toBe("2026-08-21");
  expect(refused.cursor.unreportedSinceAt).toBe(new Date(NOW - 24 * 3_600_000).toISOString());

  /* Tomorrow's run, with the account back: its window reaches back to the day
     the refused run was meant to cover. */
  ports.connectionState = { ...CONNECTED };
  ports.clock = NOW + 24 * 3_600_000;
  await runner.tick();
  await runner.settled();
  const retry = readTelegramReports().active!;
  expect(Date.parse(retry.windowStart)).toBe(NOW - 24 * 3_600_000);
});

test("a report whose items skip a number is refused instead of filed", async () => {
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  /* The operator answers "do 2" against these numbers, so a gap is not a
     cosmetic slip: it makes the report's own references ambiguous. */
  agentWrites(`${DAILY_REPORT_TAG}\n🐙 Proposed issues\n[1] Ship the export button.\n[3] Fix the timezone label.\n`);
  await runner.tick();

  const file = readTelegramReports();
  expect(file.history[0]).toMatchObject({ status: "failed", errorCode: "invalid_report", hasReport: false });
  expect(readReportText(runId)).toBeNull();
  expect(file.cursor.lastSuccessfulWindowEndAt).toBeNull();
});

test("a report with no numbered items at all is filed as it is", async () => {
  /* Numbering constrains a report that HAS proposals; a window that produced
     only attention items has nothing to number, and refusing it would drop a
     perfectly good report. */
  const ports = new FakePorts();
  enableReports();
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  const runId = activeRunId();
  agentWrites(`${DAILY_REPORT_TAG}\n👀 Worth attention\nContact A moved the review to Friday.\n`);
  await runner.tick();

  expect(readTelegramReports().history[0]).toMatchObject({ status: "ok", hasReport: true });
  expect(readReportText(runId)).toContain("Contact A moved the review");
});

test("a report is recognised by its markers whatever tag the operator chose", async () => {
  const ports = new FakePorts();
  enableReports();
  updateTelegramReports((state) => { state.prompt = "Report in Ukrainian, first line #inbox_daily."; });
  const runner = new TelegramReportRunner(ports);
  await runner.runNow();
  await runner.settled();
  agentWrites("#inbox_daily\nQUIET\n");
  await runner.tick();
  expect(readTelegramReports().history[0].status).toBe("quiet");
});
