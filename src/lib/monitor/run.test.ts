import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-run-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { ORCHESTRATOR_ALERT_REF, monitorRefIn } = await import("./cards");
const { MONITOR_MARKER } = await import("./requests");
const { runConversationMonitor } = await import("./run");
const { ViewerApiError } = await import("./viewerApi");
import type { MonitorDeps, MonitorOptions } from "./run";
import type { MonitorRunRecord } from "./types";
import type { ConversationSummary, PipelineSummary, TaskSummary, ViewerApi } from "./viewerApi";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const NOW = new Date("2026-07-27T12:00:00.000Z");
const TRACKED = "Please fix the flaky websocket reconnect in the log stream.";
const UNTRACKED = "Please add a nightly backup for the attachment store.";

interface Harness {
  api: ViewerApi;
  deps: MonitorDeps;
  runs: MonitorRunRecord[];
  delivered: { conversationId: string; text: string }[];
  tasks: TaskSummary[];
}

function harness(overrides: {
  orchestrator?: Awaited<ReturnType<ViewerApi["orchestrator"]>>;
  messages?: { kind: string; role: string; ts: string | null; text: string }[];
  tasks?: TaskSummary[];
  pipelines?: PipelineSummary[];
  conversations?: ConversationSummary[];
  /** null = no host owns the transcript; a function may throw to model an
      unprobeable viewer. */
  hostTarget?: string | null | (() => string | null);
  failTasks?: boolean;
  /** The send booted a host instead of reaching a live one. */
  deliveryResumes?: boolean;
} = {}): Harness {
  const tasks: TaskSummary[] = overrides.tasks ?? [];
  const runs: MonitorRunRecord[] = [];
  let lockHeld = false;
  const delivered: { conversationId: string; text: string }[] = [];
  let created = 0;
  const conversations: ConversationSummary[] = overrides.conversations ?? [
    { path: "/transcripts/a.jsonl", project: "viewer", title: "Session", mtime: Date.parse("2026-07-27T11:00:00Z") / 1000, kind: "session", engine: "claude" },
  ];
  const messages = overrides.messages ?? [
    { kind: "message", role: "user", ts: "2026-07-27T09:00:00Z", text: TRACKED },
    { kind: "message", role: "user", ts: "2026-07-27T09:30:00Z", text: UNTRACKED },
    { kind: "message", role: "assistant", ts: "2026-07-27T09:31:00Z", text: "Please add a nightly restore drill for the attachment store." },
  ];

  const api: ViewerApi = {
    orchestrator: async () => overrides.orchestrator ?? { record: { conversationId: "conversation_orch", path: "/transcripts/orch.jsonl", createdAt: "2026-07-01T00:00:00Z" }, exists: true, defaultCwd: "/repo" },
    hostTarget: async () => {
      if (overrides.hostTarget === undefined) return "%7";
      if (typeof overrides.hostTarget === "function") return overrides.hostTarget();
      return overrides.hostTarget;
    },
    conversations: async () => conversations,
    session: async () => messages,
    tasks: async () => {
      if (overrides.failTasks) throw new ViewerApiError("viewer request to api/tasks returned 503", 503);
      return tasks.map((task) => ({ ...task }));
    },
    pipelines: async () => overrides.pipelines ?? [],
    flows: async () => [],
    createCard: async (input) => {
      created += 1;
      const id = `task-${created}`;
      tasks.push({ id, project: input.project, status: "inbox", text: input.text, updatedAt: NOW.toISOString(), assignments: [], pipelineIds: [] });
      return { taskId: id };
    },
    deliver: async (input) => {
      delivered.push({ conversationId: input.conversationId, text: input.text });
      return overrides.deliveryResumes
        ? { outcome: "resumed", spawned: true }
        : { outcome: "delivered-to-live", spawned: false };
    },
    readRuns: async (limit) => runs.slice(-limit),
    appendRun: async (record) => void runs.push(record),
    claimRunLock: async () => {
      if (lockHeld) return { claimed: false, detail: "another monitor run holds the lock" };
      lockHeld = true;
      return { claimed: true, token: "token-1" };
    },
    releaseRunLock: async (token) => {
      if (token !== "token-1") return false;
      lockHeld = false;
      return true;
    },
  };

  let runCounter = 0;
  /* No injected journal or lock: the run reaches both through the API, which
     is the contract under test. */
  const deps: MonitorDeps = {
    api,
    now: () => NOW,
    runId: () => `run-${(runCounter += 1)}`,
  };
  return { api, deps, runs, delivered, tasks };
}

const OPTIONS: MonitorOptions = { windowHours: 6, project: "viewer" };

describe("conversation monitor run", () => {
  test("materializes exactly the untracked request and leaves the tracked one alone", async () => {
    const seeded = harness({
      tasks: [{ id: "task-tracked", project: "viewer", status: "assigned", text: "Flaky websocket reconnect in the log stream", updatedAt: "2026-07-27T11:30:00Z", assignments: [{ state: "delivered" }], pipelineIds: [] }],
    });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);

    expect(report.record.outcome).toBe("clean");
    expect(report.record.created).toHaveLength(1);
    const card = seeded.tasks.find((task) => task.id === report.record.created[0]!.taskId)!;
    expect(card.text).toContain("backup");
    expect(card.text).not.toContain("websocket");
    expect(report.classified.find((entry) => entry.request.text.includes("websocket"))!.state).toBe("in-flight");
  });

  test("re-running over the same window creates nothing further", async () => {
    const seeded = harness({
      tasks: [{ id: "task-tracked", project: "viewer", status: "assigned", text: "Flaky websocket reconnect in the log stream", updatedAt: "2026-07-27T11:30:00Z", assignments: [{ state: "delivered" }], pipelineIds: [] }],
    });
    const first = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(first.record.created).toHaveLength(1);

    const second = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(second.record.created).toHaveLength(0);
    expect(second.record.skipped.some((entry) => entry.reason === "already-tracked")).toBe(true);
    expect(seeded.tasks.filter((task) => monitorRefIn(task.text))).toHaveLength(1);
    expect(second.record.outcome).toBe("clean");
  });

  test("the card it created is the evidence that keeps the request tracked", async () => {
    const seeded = harness();
    await runConversationMonitor(seeded.deps, OPTIONS);
    const second = await runConversationMonitor(seeded.deps, OPTIONS);
    const backup = second.classified.find((entry) => entry.request.text.includes("backup"))!;
    expect(backup.state).toBe("in-flight");
    expect(backup.reason).toContain("board");
  });

  test("resolves the orchestrator through the durable record and delivers there", async () => {
    const seeded = harness();
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.orchestrator.resolution).toBe("resolved");
    expect(report.record.orchestrator.conversationId).toBe("conversation_orch");
    expect(seeded.delivered).toHaveLength(1);
    expect(seeded.delivered[0]!.conversationId).toBe("conversation_orch");
    expect(seeded.delivered[0]!.text).toContain(MONITOR_MARKER);
  });

  test("an unresolvable orchestrator is reported, not silently succeeded", async () => {
    const seeded = harness({ orchestrator: { record: null, exists: false, defaultCwd: "/repo" } });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("failed");
    expect(report.record.orchestrator.resolution).toBe("missing-record");
    expect(report.record.orchestrator.delivered).toBe(false);
    expect(seeded.delivered).toHaveLength(0);
    /* Reportable means it leaves a trace an operator will see: a board card,
       and one audit line saying the run failed. */
    expect(seeded.tasks.some((task) => monitorRefIn(task.text) === ORCHESTRATOR_ALERT_REF)).toBe(true);
    expect(seeded.runs.at(-1)!.outcome).toBe("failed");
  });

  test("a record whose transcript is gone is stale, and reported as such once", async () => {
    const seeded = harness({ orchestrator: { record: { conversationId: "conversation_dead", path: "/transcripts/gone.jsonl", createdAt: "2026-07-01T00:00:00Z" }, exists: false, defaultCwd: "/repo" } });
    const first = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(first.record.orchestrator.resolution).toBe("stale-record");
    expect(first.record.outcome).toBe("failed");
    const alerts = () => seeded.tasks.filter((task) => monitorRefIn(task.text) === ORCHESTRATOR_ALERT_REF);
    expect(alerts()).toHaveLength(1);
    await runConversationMonitor(seeded.deps, OPTIONS);
    expect(alerts()).toHaveLength(1);
  });

  test("its own delivered report is never read back as an operator request", async () => {
    const seeded = harness();
    await runConversationMonitor(seeded.deps, OPTIONS);
    const echoed = harness({
      messages: [{ kind: "message", role: "user", ts: "2026-07-27T10:00:00Z", text: seeded.delivered[0]!.text }],
    });
    const report = await runConversationMonitor(echoed.deps, OPTIONS);
    expect(report.record.found.total).toBe(0);
    expect(report.record.created).toHaveLength(0);
    expect(report.record.outcome).toBe("clean");
  });

  test("a run that finds nothing is still an audited run", async () => {
    const seeded = harness({ messages: [] });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("clean");
    expect(report.record.found.total).toBe(0);
    expect(seeded.runs).toHaveLength(1);
    expect(seeded.runs[0]!.scanned.conversations).toBe(1);
  });

  test("a viewer that refuses fails the run instead of reporting an empty board", async () => {
    const seeded = harness({ failTasks: true });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("failed");
    expect(report.record.detail).toContain("503");
    expect(report.record.created).toHaveLength(0);
    expect(seeded.runs).toHaveLength(1);
  });

  test("an overlapping run is skipped and says so", async () => {
    const seeded = harness();
    /* Model the viewer answering "held" to the claim, which is what a second
       run sees while the first is mid-sweep. */
    seeded.api.claimRunLock = async () => ({ claimed: false, detail: "another monitor run holds the lock" });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("skipped");
    expect(report.record.detail).toContain("lock");
    expect(seeded.runs).toHaveLength(1);
    expect(seeded.delivered).toHaveLength(0);
  });

  test("a lock the viewer cannot grant skips the run rather than racing", async () => {
    const seeded = harness();
    seeded.api.claimRunLock = async () => {
      throw new ViewerApiError("viewer request to api/monitor/lock returned 500", 500);
    };
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("skipped");
    expect(report.record.detail).toContain("could not be claimed");
    expect(seeded.tasks).toHaveLength(0);
  });

  test("the lock is released once the run is audited, so the next run proceeds", async () => {
    const seeded = harness();
    await runConversationMonitor(seeded.deps, OPTIONS);
    const second = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(second.record.outcome).toBe("clean");
    expect(seeded.runs).toHaveLength(2);
  });

  test("a run whose audit line cannot be written does not report success", async () => {
    const seeded = harness();
    seeded.api.appendRun = async () => {
      throw new ViewerApiError("viewer request to api/monitor/runs returned 500", 500);
    };
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.audited).toBe(false);
    expect(report.record.detail).toContain("could not be audited");
  });

  test("a dry run reports without writing board work", async () => {
    const seeded = harness();
    const report = await runConversationMonitor(seeded.deps, { ...OPTIONS, dryRun: true });
    expect(report.record.created).toHaveLength(0);
    expect(report.record.skipped.every((entry) => entry.reason === "dry-run")).toBe(true);
    expect(seeded.tasks).toHaveLength(0);
    expect(seeded.delivered).toHaveLength(0);
  });

  test("never spawns work beyond the card budget in one run", async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      kind: "message",
      role: "user",
      ts: "2026-07-27T09:00:00Z",
      text: `Please implement the ${["alpha", "beta", "gamma", "delta", "epsilon", "zeta"][index]} exporter for the archive service.`,
    }));
    const seeded = harness({ messages: many });
    const report = await runConversationMonitor(seeded.deps, { ...OPTIONS, maxCards: 2 });
    expect(report.record.created).toHaveLength(2);
    expect(report.record.skipped.filter((entry) => entry.reason === "card-budget")).toHaveLength(4);
  });

  test("the audit record carries fingerprints and counts, never transcript text", async () => {
    const seeded = harness();
    await runConversationMonitor(seeded.deps, OPTIONS);
    const serialized = JSON.stringify(seeded.runs[0]);
    expect(serialized).not.toContain("backup");
    expect(serialized).not.toContain("/transcripts/");
    expect(seeded.runs[0]!.found.fingerprints.length).toBeGreaterThan(0);
    expect(seeded.runs[0]!.window.hours).toBe(6);
  });

  test("a recorded orchestrator with no live host is reported, never nudged", async () => {
    /* The exact failure this monitor exists to end: the previous mechanism
       delivered into a conversation that had had no host for over a day, and
       the send would have resumed it. */
    const seeded = harness({ hostTarget: null });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.orchestrator.resolution).toBe("unavailable");
    expect(report.record.outcome).toBe("failed");
    expect(report.record.detail).toContain("no live host");
    expect(seeded.delivered).toHaveLength(0);
    expect(seeded.tasks.some((task) => monitorRefIn(task.text) === ORCHESTRATOR_ALERT_REF)).toBe(true);
  });

  test("a host that cannot be probed is not resolved, and nothing is delivered into the doubt", async () => {
    /* An earlier draft delivered anyway and noted the doubt. That is the old
       monitor's mistake in a politer form: an unproven audience is not an
       audience, and the send itself could resume the session. */
    const seeded = harness({
      hostTarget: () => {
        throw new ViewerApiError("viewer request to api/tmux returned 409", 409);
      },
    });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("failed");
    expect(report.record.orchestrator.resolution).toBe("unavailable");
    expect(report.record.orchestrator.delivered).toBe(false);
    expect(report.record.detail).toContain("could not be probed");
    expect(seeded.delivered).toHaveLength(0);
    /* Still reportable work: the condition lands on the board. */
    expect(seeded.tasks.some((task) => monitorRefIn(task.text) === ORCHESTRATOR_ALERT_REF)).toBe(true);
  });

  test("a path-pending record cannot be confirmed, so it is not resolved", async () => {
    /* A spawn still settling has no transcript to probe. Believing it resolved
       is precisely the assumption that let the old monitor report delivery it
       never made. */
    const seeded = harness({ orchestrator: { record: { conversationId: "conversation_new", path: null, createdAt: "2026-07-27T11:59:00Z" }, exists: true, defaultCwd: "/repo" } });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.orchestrator.resolution).toBe("unavailable");
    expect(report.record.outcome).toBe("failed");
    expect(report.record.detail).toContain("no settled transcript path");
    expect(seeded.delivered).toHaveLength(0);
  });

  test("a send that had to resume the host does not finish clean", async () => {
    const seeded = harness({ deliveryResumes: true });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.record.outcome).toBe("failed");
    expect(report.record.orchestrator.delivered).toBe(false);
    expect(report.record.detail).toContain("resume");
  });

  test("a request naming a GitHub issue is surfaced unconfirmed and no issue is created", async () => {
    const seeded = harness({
      messages: [{ kind: "message", role: "user", ts: "2026-07-27T09:00:00Z", text: "Please create a GitHub issue for the archive exporter rewrite." }],
    });
    const report = await runConversationMonitor(seeded.deps, OPTIONS);
    expect(report.classified[0]!.state).toBe("awaiting-confirmation");
    expect(seeded.tasks[0]!.text.toLowerCase()).toContain("unconfirmed");
    expect(report.message).toContain("no GitHub issue was created");
  });
});
