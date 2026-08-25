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
import { reportAttemptId, TELEGRAM_REPORT_PROJECT } from "./reportLineage";
import { beginTelegramReportReadPhase } from "./reportReadGuard";
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
 * at Connect — by NUMERIC ID and nothing else (#1091). A mismatch settles
 * `account-mismatch` before a single chat is listed and before any
 * conversation exists, and a record with no id to compare fails
 * `account_check_failed` before even that read, so "no report and no further
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
  /** The Viewer's own bounded reads: the account check and the source pass,
      every one of them bound to the credential generation the run verified
      (#1091). */
  readPort(credentialRef: string): TelegramReadPort;
  /** Runs the one-time id migration a pre-#1091 connection is owed: the
      ordinary health check, which re-reads the account through the login
      bridge and persists whatever id it reports. */
  migrateIdentity(): Promise<void>;
  /** The operator's own spawn lane, in process and outside any request scope. */
  spawn(input: ReportSpawnInput): Promise<ReportSpawnResult>;
  /** The conversation the durable report-run marker names, read from registry
      storage alone (#1091) — no Daily Reports state involved, so it answers
      after a reload that lost the launch's own write. */
  reportRunConversation(runId: string): Promise<string | null>;
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

/** The marker's read side for the runner: the durable receipt whose attempt id
    spells this run (#1091), resolved to the conversation the board shows. */
async function reportRunConversation(runId: string): Promise<string | null> {
  try {
    const { agentRegistry } = await import("@/lib/agent/registry");
    const registry = agentRegistry();
    const receipt = registry.spawnReceiptForClientAttempt(reportAttemptId(runId));
    return receipt ? registry.canonicalConversationId(receipt.conversationId) : null;
  } catch {
    return null;
  }
}

/** The one-time id migration, run through the ordinary health check so there
    is exactly one code path that re-reads an account (#1091). */
async function migrateIdentity(): Promise<void> {
  try {
    const { telegramService } = await import("./service");
    await telegramService().checkHealth();
  } catch {
    /* A health check that could not run leaves the record exactly as it was;
       the run fails closed and the next one tries again. */
  }
}

export const productionReportRunnerPorts: ReportRunnerPorts = {
  now: Date.now,
  connection: () => {
    try { return readTelegramConnection(); }
    catch { return { version: 1, status: "error", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: "session_unsafe", identityIdUpgradedAt: null }; }
  },
  readPort: (credentialRef) => connectorReadPort(credentialRef),
  migrateIdentity,
  spawn: launchReportConversation,
  reportRunConversation,
  conversationLive,
  log: (code) => console.error(`[telegram report] ${code}`),
};

/** What one run is bound to: the recorded numeric id it verified against and
    the credential generation that recorded it (#1091). */
type VerifiedAccount = { id: string; credentialRef: string };

/** A record verifies a run only when it carries BOTH — an id with no
    generation names an account nothing can be read as. */
function verifiedAccount(connection: StoredTelegramConnection): VerifiedAccount | null {
  const id = connection.identity?.id;
  return id && connection.credentialRef ? { id, credentialRef: connection.credentialRef } : null;
}

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

  /** Whether a report run may hold the connector right now: the feature is on,
      the account is connected, and — for a run that verified one — it is still
      the credential generation that run was planned for (#1091). It is passed
      to the launch as a CALLBACK, not a value, so admission resolves it after
      the source pass rather than before it: a logout during that minute must
      revoke the grant, and a reconnect as somebody else must revoke it too
      rather than hand the new account's connector to the old account's plan. */
  grantActive(credentialRef: string | null = null): boolean {
    const connection = this.ports.connection();
    if (credentialRef !== null && connection.credentialRef !== credentialRef) return false;
    return readTelegramReports().settings.enabled && connection.status === "connected";
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

  /**
   * The recorded identity a run may verify against and the credential
   * generation that recorded it, or `null` when there is none (#1091).
   *
   * "None" means the record carries no numeric account id, which is the state
   * every connection enrolled before #1091 starts in. The repair is the
   * connection's own one-time health migration: the health check re-reads the
   * account through the login bridge — the credential itself, not the surface
   * the run is checking — persists the id and stamps the record as migrated,
   * so this costs one bridge round trip per connection and never repeats.
   * A record that comes back without an id (a bridge too old to report one)
   * has already been stamped and is not re-probed: it simply has nothing to
   * verify against, and the run fails closed rather than falling back to a
   * name.
   *
   * The generation travels WITH the id because the id alone does not say which
   * credential produced it: everything the run does afterwards is bound to
   * this pair, so a logout and reconnect cannot slip a second account's
   * dialogs behind a check the first one passed.
   */
  private async verifiedIdentity(): Promise<VerifiedAccount | null> {
    const stored = this.ports.connection();
    if (stored.identity?.id) return verifiedAccount(stored);
    /* Nothing recorded to migrate, or a record already stamped as migrated:
       either way there is no id and no second bridge read to try for one. */
    if (!stored.identity || stored.identityIdUpgradedAt) return null;
    await this.ports.migrateIdentity();
    const connection = this.ports.connection();
    /* The migration re-reads the account, so it can also discover that the
       session no longer authorizes anything. */
    if (connection.status !== "connected") return null;
    return verifiedAccount(connection);
  }

  private async executeLocked(runId: string): Promise<void> {
    const file = readTelegramReports();
    const active = file.active;
    if (!active || active.runId !== runId) return;
    const window = { startAt: active.windowStart, endAt: active.windowEnd };

    /* The account check, before anything reads a chat. It needs the recorded
       numeric id, so a connection enrolled before that id existed completes its
       one-time migration HERE, first, rather than authorizing the run on a
       display name anybody can copy (#1091). A record that still carries no id
       afterwards fails the check closed, with nothing read at all. */
    const recorded = await this.verifiedIdentity();
    if (!recorded) {
      this.ports.log("account_check_failed");
      this.settle(runId, "failed", "account_check_failed", false);
      return;
    }
    /* Every read from here on is bound to the generation that recorded the id
       being verified, so the connector cannot answer this pass as a different
       account (#1091). */
    const port = this.ports.readPort(recorded.credentialRef);
    let live: Awaited<ReturnType<TelegramReadPort["getMe"]>>;
    let sourcesPath: string;
    const releaseReadPhase = await beginTelegramReportReadPhase();
    try {
      /* A mismatch is the issue's `account-mismatch` outcome: no report, no
         window advance, and — because this runs before the source pass — no
         read of the wrong account's dialogs either. */
      try {
        live = await port.getMe();
      } catch {
        this.ports.log("account_check_failed");
        this.settle(runId, "failed", "account_check_failed", false);
        return;
      }
      if (!sameTelegramAccount(live, recorded)) {
        this.ports.log("account_mismatch");
        this.settle(runId, "account-mismatch", null, false);
        return;
      }

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
    } finally {
      releaseReadPhase();
    }

    /* The source pass can take a minute; if the run was settled meanwhile —
       a restart's orphan sweep, a logout — launching now would open a
       conversation with the connector grant that nothing is tracking. */
    if (readTelegramReports().active?.runId !== runId) {
      deleteRunScratch(runId);
      return;
    }
    /* A reconnect inside that same minute is the other way this run stops
       being about the account it verified (#1091). Every read the plan is made
       of was refused the moment the generation moved, so what is on disk is
       one account's — but the conversation about to be launched would hold the
       NEW account's connector, so there is nothing left to run. The plan goes
       with it rather than sitting in scratch naming the departed account's
       correspondents. */
    if (this.ports.connection().credentialRef !== recorded.credentialRef) {
      this.ports.log("account_mismatch");
      deleteRunScratch(runId);
      this.settle(runId, "account-mismatch", null, false);
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
          /* The durable report-run marker (#1091), in the two fields the
             ordinary spawn path already makes durable: the receipt's attempt
             id spells the run id, and explicit project ownership is what the
             board groups the card by. Still no `src`, `parent` or role — see
             `reportLineage.ts` for why a lineage parent would revoke the run's
             own connector grant. */
          clientAttemptId: reportAttemptId(runId),
          project: TELEGRAM_REPORT_PROJECT,
          ["prompt"]: prompt,
        },
        /* The grant is decided by the report session class, inside admission,
           from durable state read at that instant — and only for the
           generation this run verified (#1091). */
        grantActive: () => this.grantActive(recorded.credentialRef),
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
   * Re-links a live run to its conversation from the durable marker (#1091).
   *
   * The launch's own write of the conversation id is the LAST thing
   * `executeLocked` does, so a process that died between the spawn being
   * admitted and that write left a run nothing could name: a real conversation
   * on the board, a panel row with no route to it, and a sweep about to call
   * it a launch that never happened. The marker is the durable evidence that
   * repairs it — the receipt's attempt id spells the run id, in registry
   * storage, which is exactly what survives the reload — and the recovered id
   * is persisted, so the settled history row carries it too.
   *
   * Only a run this process is NOT planning is looked up: while the source
   * pass is still running here the launch has not happened yet, so there is
   * nothing to find and no reason to read the registry every tick.
   */
  private async relinkActiveRun(runId: string): Promise<string | null> {
    if (this.planning.has(runId)) return null;
    const conversationId = await this.ports.reportRunConversation(runId);
    if (!conversationId) return null;
    updateTelegramReports((state) => {
      if (state.active?.runId === runId && !state.active.conversationId) state.active.conversationId = conversationId;
    });
    return conversationId;
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
    const conversationId = active.conversationId ?? await this.relinkActiveRun(active.runId);
    if (!conversationId) {
      /* No conversation yet: either this process is still planning the run's
         sources, or the process that was doing so is gone and the run is an
         orphan no restart would otherwise clear. */
      if (!this.planning.has(active.runId)) this.settle(active.runId, "failed", "launch_failed", false);
      else if (expired) this.settle(active.runId, "failed", "timed_out", false);
      return;
    }
    const alive = await this.ports.conversationLive(conversationId);
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
 * Whether the connector is logged into the account this report belongs to.
 *
 * THE NUMERIC ACCOUNT ID IS THE WHOLE ANSWER (issue #1091). It is the only
 * field of an account nobody can hand themselves, so equal ids are the same
 * account whatever it is called today, and anything else is not this account:
 * a different id is a different account however familiar its display name, and
 * a MISSING id on either side is no evidence at all.
 *
 * There is no name or handle rule here any more, deliberately. Both fields are
 * public and copyable, which is exactly how the v1 check let a second account
 * wearing the operator's name pass; keeping them as a fallback for records that
 * carry no id would leave that same hole open for every connection enrolled
 * before the id existed. Those records are repaired instead — the runner
 * completes their one-time health migration (`recordedIdentityAfterHealthCheck`)
 * before a run is allowed to read anything — and a record that still has no id
 * afterwards fails the check closed.
 */
export function sameTelegramAccount(
  live: { id?: string | null } | null,
  recorded: { id?: string | null } | null,
): boolean {
  return Boolean(live?.id && recorded?.id && live.id === recorded.id);
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
