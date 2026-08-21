import crypto from "node:crypto";

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
import { launchReportConversation, type ReportSpawnInput, type ReportSpawnResult } from "./reportSpawn";
import {
  clearTelegramReports,
  deleteReportArtifacts,
  deleteRunScratch,
  effectiveReportPrompt,
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
 *   verify get_me → plan sources → launch → (tick) ingest output OR observe
 *   the conversation ended OR time out → finalize the history row.
 *
 * The account check is the FIRST thing that happens and the Viewer does it
 * itself, through the connector's own `get_me`, against the identity recorded
 * at Connect. A mismatch settles `account-mismatch` before a single chat is
 * listed and before any conversation exists, so "no report and no further
 * reads" is a property of the code rather than an instruction an agent is
 * trusted to follow — and the recorded identity never has to enter a prompt.
 *
 * Only `ok` and `quiet` advance the window cursor, and a failed run records the
 * boundary it did not reach, so the day it missed is covered by the next run's
 * window (capped at 72 h) instead of being lost.
 *
 * Nothing here logs a value. {@link ReportRunnerPorts.log} takes a code from a
 * closed vocabulary and nothing else: the errors this module catches come from
 * the connector, the account store and the spawn lane, and any of them can
 * carry a chat title, a handle or a token in its message. The history row is
 * where a failure is explained, and it carries a sanitized code too.
 */

/** A run that has produced nothing by then is over, whatever the board says. */
export const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const TICK_MS = 60_000;

/** Everything this module will ever write to the host log. */
export type ReportRunnerLogCode =
  | "tick_failed"
  | "account_check_failed"
  | "account_mismatch"
  | "sources_failed"
  | "launch_failed"
  | "launch_rejected"
  | "run_failed";

export interface ReportRunnerPorts {
  now(): number;
  connection(): StoredTelegramConnection;
  /** The Viewer's own bounded reads: the account check and the source pass. */
  readPort(): TelegramReadPort;
  /** The operator's own spawn lane, in process and outside any request scope. */
  spawn(input: ReportSpawnInput): Promise<ReportSpawnResult>;
  /** Whether the launched conversation is still able to produce a report. */
  conversationLive(conversationId: string): Promise<boolean>;
  log(code: ReportRunnerLogCode): void;
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
  spawn: launchReportConversation,
  conversationLive,
  log: (code) => console.error(`[telegram report] ${code}`),
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
      and the account is connected. It is passed to the launch as a CALLBACK,
      not a value, so admission resolves it after the source pass rather than
      before it — a logout during that minute must revoke the grant, not be
      overtaken by state read before it happened. */
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
      /* The prompt itself is never part of this payload — the panel polls it
         every twenty seconds, and the brief may name private chats. */
      settings: { ...file.settings, promptIsDefault: file.prompt === null },
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
    } catch {
      this.ports.log("tick_failed");
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
    } catch {
      this.ports.log("run_failed");
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
    const port = this.ports.readPort();

    /* The account check, before anything reads a chat. A mismatch is the
       issue's `account-mismatch` outcome: no report, no window advance, and —
       because this runs before the source pass — no read of the wrong
       account's dialogs either. */
    let live: Awaited<ReturnType<TelegramReadPort["getMe"]>>;
    try {
      live = await port.getMe();
    } catch {
      this.ports.log("account_check_failed");
      this.settle(runId, "failed", "account_check_failed", false);
      return;
    }
    if (!sameTelegramAccount(live, connection.identity)) {
      this.ports.log("account_mismatch");
      this.settle(runId, "account-mismatch", null, false);
      return;
    }

    let sourcesPath: string;
    try {
      const plan = await planReportSources(port, {
        windowStart: window.startAt,
        windowEnd: window.endAt,
        groups: file.settings.groups,
        promptVersion: DAILY_REPORT_PROMPT_VERSION,
      });
      sourcesPath = writeReportSources(runId, plan);
    } catch {
      this.ports.log("sources_failed");
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
    /* The operator's own brief, with the Viewer's non-negotiable preamble in
       front of it. Their text may name private chats, which is why it reaches
       nothing but the run it was written for. */
    const prompt = renderDailyReportPrompt({
      windowStart: window.startAt,
      windowEnd: window.endAt,
      sourcesPath,
      outputPath: reportInboxPath(runId),
      instructions: effectiveReportPrompt(readTelegramReports()),
    });
    let spawned: ReportSpawnResult;
    try {
      spawned = await this.ports.spawn({
        body: {
          engine: "codex",
          model: CODEX_SOL_MODEL,
          effort: "medium",
          cwd: reportWorkspaceDir(),
          /* The durable marker that ties this conversation to this run, both
             ways: the receipt carries it, and the history row carries the
             conversation the receipt produced. No `src`, `parent` or role — see
             the note on lineage at the bottom of this file. */
          clientAttemptId: reportAttemptId(runId),
          ["prompt"]: prompt,
        },
        /* The grant is decided by the report session class, inside admission,
           from durable state read at that instant. */
        grantActive: () => this.grantActive(),
      });
    } catch {
      this.ports.log("launch_failed");
      this.settle(runId, "failed", "launch_failed", false);
      return;
    }
    const conversationId = typeof spawned.body.conversationId === "string" ? spawned.body.conversationId : null;
    const admitted = spawned.status >= 200 && spawned.status < 300 && spawned.body.ok !== false && conversationId !== null;
    if (!admitted) {
      this.ports.log("launch_rejected");
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
    const ingested = ingestReportInbox(active.runId);
    const outcome = classifyReportOutput(ingested);
    if (outcome.kind === "ok") {
      saveReportText(active.runId, outcome.report);
      this.settle(active.runId, "ok", null, true);
      return;
    }
    if (outcome.kind === "quiet") {
      this.settle(active.runId, "quiet", null, false);
      return;
    }
    if (outcome.kind === "invalid" && ingested !== null) {
      /* The run wrote a file that is not a report: prose, a refusal, a half
         format, items numbered [1] [2] [4]. Filing it as the day's report
         would advance the window over a day nobody has actually read, so it
         fails and the window stays owed. */
      this.settle(active.runId, "failed", "invalid_report", false);
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
      /* Only a run that actually covered the window moves the cursor. Every
         other outcome records the boundary this run did NOT reach, so the next
         run starts there instead of 24 h before itself. The earliest such
         boundary wins; the 72 h cap is applied when the window is built. */
      if (status !== "ok" && status !== "quiet") {
        const owed = state.cursor.unreportedSinceAt;
        if (!owed || Date.parse(active.windowStart) < Date.parse(owed)) {
          state.cursor.unreportedSinceAt = active.windowStart;
        }
        return;
      }
      state.cursor.lastSuccessfulWindowEndAt = active.windowEnd;
      state.cursor.unreportedSinceAt = null;
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

  /**
   * A launch that never started still owes the operator a visible row — and it
   * owes the WINDOW too. A scheduled run refused at the preflight (Telegram
   * disconnected, reports switched off between the tick and the check) has had
   * its day stamped by `tick`, so without recording the boundary here the day
   * it was meant to cover would simply be gone and the next successful run
   * would start 24 h before ITSELF. Same rule as {@link settle}: the earliest
   * unreported boundary wins, and the 72 h cap is applied when the window is
   * built.
   */
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
      /* `reports_disabled` is the one code that means no run was OWED — the
         feature is off, so there is no window anybody expected covered. Every
         other refusal is a run that should have happened. */
      if (code === "reports_disabled") return;
      const owed = state.cursor.unreportedSinceAt;
      if (!owed || Date.parse(window.startAt) < Date.parse(owed)) {
        state.cursor.unreportedSinceAt = window.startAt;
      }
    });
    return { ok: false, code };
  }
}

/**
 * Characters the connector strips from every name it returns.
 *
 * Its `sanitize_name` removes Unicode Cc/Cf (which covers the zero-width and
 * bidi block) and collapses whitespace, while the identity recorded at Connect
 * comes off the login bridge UNSANITIZED. Two spellings of one name therefore
 * have to be normalized to the same thing before they are compared, or an
 * operator whose display name carries an invisible character would fail every
 * report with `account-mismatch` and never learn why.
 */
const STRIPPED_BY_CONNECTOR = /[\p{Cc}\p{Cf}]/gu;

/** Both sides spell "this account has no name" with their own placeholder, and
    neither is evidence of anything. */
const NAME_PLACEHOLDERS = new Set(["[empty]", "telegram account"]);

function comparableName(value: string): string {
  const normalized = value.replace(STRIPPED_BY_CONNECTOR, "").replace(/\s+/g, " ").trim().toLowerCase();
  return NAME_PLACEHOLDERS.has(normalized) ? "" : normalized;
}

/**
 * Whether the connector is logged into the account this report belongs to.
 *
 * The evidence is the identity Connect recorded — display name and public
 * handle — because that is what the operator's connection carries; the
 * connector's `get_me` is asked for the same two fields.
 *
 * AGREEMENT ON EITHER field is enough, and that is deliberate. Both fields are
 * the operator's to change at any moment, and the recorded copy is only
 * refreshed by a health check, so demanding that both agree would end every
 * report with `account-mismatch` the day the operator renamed themselves or
 * took a new @handle — a silently dead feature, which is a worse failure than
 * the one this check exists to catch. A genuinely different account agrees on
 * neither. A connection with NO comparable field cannot be verified against
 * anything, so it fails closed.
 */
export function sameTelegramAccount(
  live: { name: string; username: string | null } | null,
  recorded: { name: string; username: string | null } | null,
): boolean {
  if (!live || !recorded) return false;
  const liveName = comparableName(live.name);
  const recordedName = comparableName(recorded.name);
  if (liveName && recordedName && liveName === recordedName) return true;
  const liveHandle = (live.username ?? "").trim().toLowerCase();
  const recordedHandle = (recorded.username ?? "").trim().toLowerCase();
  return Boolean(liveHandle) && liveHandle === recordedHandle;
}

/**
 * The durable identity the launch carries into the registry (issue #1086).
 *
 * `clientAttemptId` is the spawn lane's own replay key: it is written on the
 * receipt, resolvable through `spawnReceiptForClientAttempt`, and it survives a
 * restart. Together with the `conversationId` the history row keeps, it is the
 * two-way link between a report row and the board conversation that produced
 * it.
 *
 * A lineage PARENT is deliberately not used, and the reason is mechanical: the
 * registry re-decides every stored MCP grant from the row's own evidence
 * (`mcpServersForStoredSession` at `registry.ts`, `decideStoredGrant` in
 * `mcpAllowlist.ts`), and a `parentConversationId` classifies the row as
 * delegated, whose grant is the baseline. A report run given a parent would
 * therefore lose `telegram` at the moment its receipt is written. It is also
 * true rather than convenient: no conversation spawns the 10:00 report.
 */
export function reportAttemptId(runId: string): string {
  return `telegram-report-${runId}`;
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
 * It is started by the release that owns traffic (`startCurrentReleaseControllers`),
 * like every other Viewer controller, so a standalone Viewer nobody has opened
 * in a browser still runs its report. The Telegram API route ensures it too,
 * which is harmless: this is one globalThis singleton per process. The first
 * tick after a start catches up a slot that passed while the process was down,
 * because `scheduledRunDue` compares the stamped day against the clock instead
 * of counting on a timer that was ticking.
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
