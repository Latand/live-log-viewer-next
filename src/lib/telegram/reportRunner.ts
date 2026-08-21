import crypto from "node:crypto";

import type { NextRequest } from "next/server";

import { mcpServersForScheduledReport } from "@/lib/agent/mcpAllowlist";
import { CODEX_SOL_MODEL } from "@/lib/agent/models";

import {
  REPORT_TIME_ZONE,
  type TelegramReportErrorCode,
  type TelegramReportRow,
  type TelegramReportTrigger,
  type TelegramReportsPayload,
} from "./reportContracts";
import {
  DAILY_REPORT_PROMPT_VERSION,
  classifyReportOutput,
  renderDailyReportPrompt,
} from "./reportPrompt";
import {
  localDayKey,
  nextScheduledRunAt,
  reportWindowFor,
  scheduledRunDue,
  slotInstant,
} from "./reportSchedule";
import { connectorReadPort, planReportSources, type TelegramReadPort } from "./reportSources";
import {
  clearTelegramReports,
  deleteReportArtifacts,
  deleteRunScratch,
  ingestReportInbox,
  readTelegramReports,
  reportInboxPath,
  reportWorkspaceDir,
  saveReportText,
  updateTelegramReports,
  writeReportSources,
} from "./reportStore";
import { readTelegramConnection, type StoredTelegramConnection } from "./sessionStore";

/**
 * The Daily Report runner and its scheduler (issue #1086).
 *
 * A run is one Viewer-launched, board-visible Codex conversation — never a
 * detached `codex exec` — that holds the `telegram` grant through the session
 * class in `mcpAllowlist.ts`, reads the sources the Viewer planned for it, and
 * writes its report to an owner-only inbox file. The Viewer never reads a
 * Telegram message itself, so no message body can reach its logs or registry;
 * what it keeps is the status, the window, and a sanitized error code.
 *
 * Lifecycle, all of it durable so a Viewer restart resumes mid-run:
 *
 *   plan sources → launch → (tick) ingest output OR observe the conversation
 *   ended OR time out → finalize the history row.
 *
 * Only `ok` and `quiet` advance the window cursor, so a failed day is covered
 * by the next run's window (capped at 72 h) instead of being lost.
 */

/** A run that has produced nothing by then is over, whatever the board says. */
export const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const TICK_MS = 60_000;

export interface ReportRunnerPorts {
  now(): number;
  connection(): StoredTelegramConnection;
  readPort(): TelegramReadPort;
  /** POST /api/spawn in-process, on the operator's own authority. */
  spawn(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Whether the launched conversation is still able to produce a report. */
  conversationLive(conversationId: string): Promise<boolean>;
  log(message: string, error?: unknown): void;
}

async function postSpawnInProcess(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const [{ executeSpawnRequest }, { ensureOperatorSpawnCapability }, { VIEWER_SPAWN_CAPABILITY_HEADER }] = await Promise.all([
    import("@/lib/agent/spawnCommand"),
    import("@/lib/agent/operatorCapability"),
    import("@/lib/agent/spawnPolicy"),
  ]);
  /* The operator's own spawn lane, exactly as the orchestrator seat uses it:
     the launch is the Viewer acting for the operator, not an agent asking. */
  const request = {
    headers: new Headers({ host: "127.0.0.1", [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability() }),
    json: async () => body,
  } as unknown as NextRequest;
  const response = await executeSpawnRequest(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function conversationLive(conversationId: string): Promise<boolean> {
  try {
    const { agentRegistry } = await import("@/lib/agent/registry");
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    if (!conversation) return false;
    return conversation.turn?.state !== "terminal";
  } catch {
    /* An unreadable registry is not evidence that the run died; the timeout
       remains the backstop. */
    return true;
  }
}

export const productionReportRunnerPorts: ReportRunnerPorts = {
  now: Date.now,
  connection: () => {
    try { return readTelegramConnection(); }
    catch { return { version: 1, status: "error", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: "session_unsafe" }; }
  },
  readPort: connectorReadPort,
  spawn: postSpawnInProcess,
  conversationLive,
  log: (message, error) => console.error(message, error),
};

export type RunLaunchResult =
  /** The run is durable and visible; its conversation opens behind this. */
  | { ok: true; runId: string }
  | { ok: false; code: TelegramReportErrorCode };

export class TelegramReportRunner {
  private running = false;
  /** Runs whose source pass THIS process is executing right now; an active row
      outside this set has been orphaned by a restart. */
  private readonly planning = new Set<string>();
  private pending: Promise<void>[] = [];

  constructor(private readonly ports: ReportRunnerPorts = productionReportRunnerPorts) {}

  /** Whether a report run may hold the connector right now: the feature is on
      and the account is connected. Both halves are re-read from durable state
      at every launch, which is what makes logout revoke the grant. */
  grantActive(): boolean {
    return readTelegramReports().settings.enabled && this.ports.connection().status === "connected";
  }

  payload(): TelegramReportsPayload {
    const file = readTelegramReports();
    const history = file.active
      ? [activeRow(file.active), ...file.history]
      : file.history;
    const next = nextScheduledRunAt({ now: this.ports.now(), settings: file.settings, cursor: file.cursor });
    return {
      settings: file.settings,
      history,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
    };
  }

  /**
   * One scheduler step: reconcile a live run, drop state that a logged-out
   * account no longer owns, then fire the day's scheduled run if it is owed.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.reconcileDisconnected();
      await this.finalizeActiveRun();
      const file = readTelegramReports();
      if (file.active) return;
      if (!scheduledRunDue({ now: this.ports.now(), settings: file.settings, cursor: file.cursor })) return;
      const day = localDayKey(this.ports.now(), REPORT_TIME_ZONE);
      /* Stamp the day BEFORE launching: a launch that throws must not leave
         the slot armed for an immediate retry loop. The failed row records
         what happened, and the window cursor still covers the missed day. */
      updateTelegramReports((state) => { state.cursor.lastScheduledDay = day; });
      const begun = this.beginRun("scheduled");
      if (begun.ok) await this.execute(begun.runId);
    } catch (error) {
      this.ports.log("[telegram report] scheduler tick failed", error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Operator-pressed Run now.
   *
   * It RETURNS as soon as the run exists, because the work that follows —
   * a chat listing plus one bounded probe per candidate dialog, all
   * sequential — takes tens of seconds against a real connector, and no
   * browser request should be held open for it. The row the operator sees
   * appears immediately as `running`, and the poll follows it from there.
   */
  async runNow(): Promise<RunLaunchResult> {
    if (this.running) return { ok: false, code: "run_in_progress" };
    this.running = true;
    let started: RunLaunchResult;
    try {
      await this.finalizeActiveRun();
      if (readTelegramReports().active) return { ok: false, code: "run_in_progress" };
      started = this.beginRun("manual");
    } finally {
      this.running = false;
    }
    if (!started.ok) return started;
    /* The active row is now the mutual exclusion: `tick` returns early while
       one exists, so nothing else can start a second run. */
    const work = this.execute(started.runId);
    this.pending.push(work);
    void work.finally(() => { this.pending = this.pending.filter((entry) => entry !== work); });
    return started;
  }

  /** Settles the work Run now left in flight. Tests await it; production
      never needs to, because every outcome is durable. */
  async settled(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
  }

  /** A Telegram that is neither connected nor holding a credential has been
      logged out or locally deleted; its reports are readings of that account
      and go with it. */
  private reconcileDisconnected(): void {
    const connection = this.ports.connection();
    if (connection.status !== "disconnected" || connection.credentialRef !== null) return;
    const file = readTelegramReports();
    if (!file.settings.enabled && file.history.length === 0 && !file.active) return;
    clearTelegramReports();
  }

  /**
   * Opens the run: the refusals that can be decided without touching Telegram,
   * then the durable active row — created BEFORE the source pass so the panel
   * has something truthful to show while that pass runs, and so a run
   * interrupted mid-pass is a row somebody can settle rather than a silence.
   */
  private beginRun(trigger: TelegramReportTrigger): RunLaunchResult {
    const file = readTelegramReports();
    const connection = this.ports.connection();
    if (!file.settings.enabled) return this.recordFailure(trigger, "reports_disabled");
    if (connection.status !== "connected") return this.recordFailure(trigger, "not_connected");
    const runId = crypto.randomUUID();
    const window = reportWindowFor(this.ports.now(), file.cursor);
    this.planning.add(runId);
    updateTelegramReports((state) => {
      state.active = {
        runId,
        trigger,
        startedAt: new Date(this.ports.now()).toISOString(),
        windowStart: window.startAt,
        windowEnd: window.endAt,
        conversationId: null,
        promptVersion: DAILY_REPORT_PROMPT_VERSION,
      };
    });
    return { ok: true, runId };
  }

  /** Plans the sources and launches the conversation for an open run. Every
      exit either hands the run a conversation or settles it as failed. */
  private async execute(runId: string): Promise<void> {
    try {
      await this.executeLocked(runId);
    } catch (error) {
      this.ports.log("[telegram report] run failed", error);
      this.settle(runId, "failed", "launch_failed", false);
    } finally {
      this.planning.delete(runId);
    }
  }

  private async executeLocked(runId: string): Promise<void> {
    const file = readTelegramReports();
    const connection = this.ports.connection();
    const active = file.active;
    if (!active || active.runId !== runId) return;
    const window = { startAt: active.windowStart, endAt: active.windowEnd };
    let sourcesPath: string;
    try {
      const plan = await planReportSources(this.ports.readPort(), {
        windowStart: window.startAt,
        windowEnd: window.endAt,
        groups: file.settings.groups,
        promptVersion: DAILY_REPORT_PROMPT_VERSION,
      });
      sourcesPath = writeReportSources(runId, plan);
    } catch (error) {
      this.ports.log("[telegram report] source discovery failed", error);
      this.settle(runId, "failed", "sources_failed", false);
      return;
    }

    /* The source pass can take a minute; if the run was settled meanwhile —
       a restart's orphan sweep, a logout — launching now would open a
       conversation with the connector grant that nothing is tracking. */
    if (readTelegramReports().active?.runId !== runId) {
      deleteRunScratch(runId);
      return;
    }
    const prompt = renderDailyReportPrompt({
      windowStart: window.startAt,
      windowEnd: window.endAt,
      sourcesPath,
      outputPath: reportInboxPath(runId),
      identity: connection.identity,
    });
    /* The grant is decided here, by the session class, from durable state —
       never copied from the request or from a previous run. */
    const mcpServers = mcpServersForScheduledReport({ grantActive: true });
    let spawned: { status: number; body: Record<string, unknown> };
    try {
      spawned = await this.ports.spawn({
        engine: "codex",
        model: CODEX_SOL_MODEL,
        effort: "medium",
        cwd: reportWorkspaceDir(),
        mcpServers,
        clientAttemptId: `telegram-report-${runId}`,
        ["prompt"]: prompt,
      });
    } catch (error) {
      this.ports.log("[telegram report] launch failed", error);
      this.settle(runId, "failed", "launch_failed", false);
      return;
    }
    const conversationId = typeof spawned.body.conversationId === "string" ? spawned.body.conversationId : null;
    const admitted = spawned.status >= 200 && spawned.status < 300 && spawned.body.ok !== false && conversationId !== null;
    if (!admitted) {
      this.ports.log(`[telegram report] launch rejected with HTTP ${spawned.status}`);
      this.settle(runId, "failed", "launch_failed", false);
      return;
    }
    updateTelegramReports((state) => {
      if (state.active?.runId === runId) state.active.conversationId = conversationId;
    });
  }

  /**
   * Settles a live run if it has produced anything, ended, or run out of time.
   * The output file is checked FIRST: a run whose conversation has already
   * gone terminal may well have written a perfectly good report on its way
   * out, and a report on disk is the fact that matters.
   */
  private async finalizeActiveRun(): Promise<void> {
    const active = readTelegramReports().active;
    if (!active) return;
    const outcome = classifyReportOutput(ingestReportInbox(active.runId));
    if (outcome.kind === "ok") {
      saveReportText(active.runId, outcome.report);
      this.settle(active.runId, "ok", null, true);
      return;
    }
    if (outcome.kind === "quiet") {
      this.settle(active.runId, "quiet", null, false);
      return;
    }
    if (outcome.kind === "account-mismatch") {
      /* The window is NOT advanced: nothing was read, so the next run with the
         right account still covers this period. */
      this.settle(active.runId, "account-mismatch", null, false);
      return;
    }
    const startedAt = Date.parse(active.startedAt);
    const expired = Number.isFinite(startedAt) && this.ports.now() - startedAt > RUN_TIMEOUT_MS;
    if (!active.conversationId) {
      /* No conversation yet: either this process is still planning the run's
         sources, or the process that was doing so is gone and the run is an
         orphan no restart would otherwise clear. */
      if (!this.planning.has(active.runId)) this.settle(active.runId, "failed", "launch_failed", false);
      else if (expired) this.settle(active.runId, "failed", "timed_out", false);
      return;
    }
    const alive = await this.ports.conversationLive(active.conversationId);
    if (!alive) {
      /* A run that ended — including a connector crash that took the turn down
         with it — never silently succeeds. It becomes a failed row the
         operator can retry, and the window it did not cover stays owed. */
      this.settle(active.runId, "failed", "run_ended_without_report", false);
      return;
    }
    if (expired) this.settle(active.runId, "failed", "timed_out", false);
  }

  private settle(
    runId: string,
    status: TelegramReportRow["status"],
    errorCode: TelegramReportErrorCode | null,
    hasReport: boolean,
  ): void {
    updateTelegramReports((state) => {
      const active = state.active;
      if (!active || active.runId !== runId) return;
      state.active = null;
      state.history = [{
        id: active.runId,
        trigger: active.trigger,
        startedAt: active.startedAt,
        finishedAt: new Date(this.ports.now()).toISOString(),
        windowStart: active.windowStart,
        windowEnd: active.windowEnd,
        status,
        errorCode,
        conversationId: active.conversationId,
        hasReport,
        promptVersion: active.promptVersion,
      }, ...state.history];
      /* Only a run that actually covered the window moves the cursor. */
      if (status !== "ok" && status !== "quiet") return;
      state.cursor.lastSuccessfulWindowEndAt = active.windowEnd;
      /* A successful run satisfies the day's slot whoever asked for it: a
         Run now at 10:05 must not be followed by the 10:00 scheduled run
         reporting the five minutes since. A run BEFORE the slot leaves the
         day unstamped, so the scheduled report still arrives on time. */
      const today = localDayKey(this.ports.now(), REPORT_TIME_ZONE);
      if (this.ports.now() >= slotInstant(today, state.settings.time, REPORT_TIME_ZONE)) {
        state.cursor.lastScheduledDay = today;
      }
    });
    /* The source plan and the inbox belong to the run, not to its history. */
    if (hasReport) deleteRunScratch(runId);
    else deleteReportArtifacts(runId);
  }

  /** A launch that never started still owes the operator a visible row. */
  private recordFailure(
    trigger: TelegramReportTrigger,
    code: TelegramReportErrorCode,
    window = reportWindowFor(this.ports.now(), readTelegramReports().cursor),
  ): RunLaunchResult {
    const at = new Date(this.ports.now()).toISOString();
    updateTelegramReports((state) => {
      state.history = [{
        id: crypto.randomUUID(),
        trigger,
        startedAt: at,
        finishedAt: at,
        windowStart: window.startAt,
        windowEnd: window.endAt,
        status: "failed",
        errorCode: code,
        conversationId: null,
        hasReport: false,
        promptVersion: DAILY_REPORT_PROMPT_VERSION,
      }, ...state.history];
    });
    return { ok: false, code };
  }
}

function activeRow(active: NonNullable<ReturnType<typeof readTelegramReports>["active"]>): TelegramReportRow {
  return {
    id: active.runId,
    trigger: active.trigger,
    startedAt: active.startedAt,
    finishedAt: null,
    windowStart: active.windowStart,
    windowEnd: active.windowEnd,
    status: "running",
    errorCode: null,
    conversationId: active.conversationId,
    hasReport: false,
    promptVersion: active.promptVersion,
  };
}

/* One runner and one timer per process, across route bundles — the same
   globalThis seam the flow-pipeline controller uses, for the same reason. */
const host = globalThis as typeof globalThis & {
  __llvTelegramReportRunner?: TelegramReportRunner;
  __llvTelegramReportTimer?: ReturnType<typeof setInterval>;
};

export function telegramReportRunner(): TelegramReportRunner {
  return host.__llvTelegramReportRunner ??= new TelegramReportRunner();
}

/**
 * Starts (once) the scheduler that fires the day's run.
 *
 * It is ensured from the Telegram API route, which the always-mounted footer
 * row polls: with a Viewer open the timer runs, and with no Viewer running at
 * all there is nothing to run a report in anyway — the first tick after start
 * catches up a slot that passed while the process was down, because
 * `scheduledRunDue` compares the stamped day, not a timer that was ticking.
 */
export function ensureTelegramReportScheduler(): void {
  if (host.__llvTelegramReportTimer) return;
  host.__llvTelegramReportTimer = setInterval(() => {
    void telegramReportRunner().tick();
  }, TICK_MS);
  host.__llvTelegramReportTimer.unref?.();
  void telegramReportRunner().tick();
}

export function setTelegramReportRunnerForTests(runner: TelegramReportRunner | null): void {
  if (runner) host.__llvTelegramReportRunner = runner;
  else delete host.__llvTelegramReportRunner;
}
