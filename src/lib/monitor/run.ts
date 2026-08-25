import crypto from "node:crypto";

import { classifyRequest, DEFAULT_STALL_AFTER_MS } from "./classify";
import { monitorClientRequestId, monitorCardText, ORCHESTRATOR_ALERT_REF, orchestratorAlertCardText } from "./cards";
import { evidenceFromFlows, evidenceFromGithub, evidenceFromPipelines, evidenceFromTasks, type GithubEvidenceRow } from "./evidence";
import { redactMonitorText } from "./redact";
import { renderMonitorReport } from "./report";
import { operatorRequestsFrom } from "./requests";
import type {
  ClassifiedRequest,
  EvidenceItem,
  MonitorCreation,
  MonitorRunRecord,
  MonitorRunReport,
  MonitorSkip,
  OperatorRequest,
  OrchestratorResolution,
  RequestState,
} from "./types";
import type { ConversationSummary, ViewerApi } from "./viewerApi";

/**
 * One run of the recurring conversation monitor (issue #741).
 *
 * The shape of the thing this replaces is worth stating, because every rule
 * here exists to close one of its holes: it read a state file directly, nudged
 * a HARD-CODED transcript path belonging to a predecessor orchestrator that
 * had had no live host for over a day, created no tracked work, and wrote
 * nothing on success — so its empty log was equally consistent with perfect
 * operation and with total failure.
 *
 * So: the orchestrator is resolved through its project seat and addressed by
 * conversation id; gaps become board cards through the API; every run appends
 * exactly one audit line; and a run that cannot resolve an orchestrator fails
 * loudly and puts the condition on the board.
 */

/** States that deserve a card of their own; the rest already have tracked work. */
const MATERIALIZED_STATES: RequestState[] = ["untracked", "awaiting-confirmation"];

const DEFAULT_WINDOW_HOURS = 6;
const DEFAULT_MAX_CONVERSATIONS = 40;
const DEFAULT_MAX_CARDS = 5;

/** The single-flight admission, held for the length of one run. */
export type MonitorClaim =
  | { claimed: true; release(): Promise<void> }
  | { claimed: false; detail: string };

export interface MonitorDeps {
  api: ViewerApi;
  now(): Date;
  runId?(): string;
  /** Overrides the API-backed journal; production leaves it unset, so the
      viewer owns the file and the monitor owns none. */
  appendRun?(record: MonitorRunRecord): Promise<void>;
  /** Overrides the API-backed single-flight claim, same reasoning. */
  claim?(): Promise<MonitorClaim>;
  /** Optional pull-request / issue correlation. A source that cannot answer
      throws; the run then continues without it and says so. */
  github?(): Promise<GithubEvidenceRow[]>;
}

export interface MonitorOptions {
  windowHours?: number;
  /** Project scope. Live runs require it because orchestrator seats are
      per-project and no global designation remains. */
  project?: string | null;
  maxConversations?: number;
  maxCards?: number;
  stallAfterMs?: number;
  /** Classify and report, write nothing. */
  dryRun?: boolean;
  /** Deliver even when the window produced nothing; off, so a quiet half-hour
      does not put a heartbeat in the operator's conversation. */
  deliverWhenEmpty?: boolean;
}

function emptyByState(): Record<RequestState, number> {
  return { completed: 0, "in-flight": 0, stalled: 0, untracked: 0, "awaiting-confirmation": 0 };
}

/**
 * Who to talk to, and whether anyone is listening.
 *
 * The seat answers the first question durably — a conversation id, which
 * follows the orchestrator across rollovers, restarts and model swaps. The
 * second question needs the host probe, and it is the one the mechanism this
 * replaces never asked: it nudged a conversation that had had no live host for
 * over a day. Delivering into a hostless conversation would also RESUME it,
 * and waking sessions is not the monitor's business.
 */
async function resolveOrchestrator(api: ViewerApi, project: string): Promise<{ resolution: OrchestratorResolution; path: string | null; note: string | null }> {
  let status: Awaited<ReturnType<ViewerApi["orchestrator"]>>;
  try {
    status = await api.orchestrator(project);
  } catch (error) {
    return { resolution: { kind: "unavailable", detail: `the orchestrator seat could not be read: ${errorText(error)}` }, path: null, note: null };
  }
  if (!status.record) return { resolution: { kind: "missing-record" }, path: null, note: null };
  const { conversationId, path } = status.record;
  if (!status.exists) return { resolution: { kind: "stale-record", conversationId }, path, note: null };
  /* A seat with no settled transcript path cannot be probed, so nothing here
     can show that anyone is listening. Unproven is not resolved: the whole
     failure this monitor exists to end was a predecessor believing it had
     delivered when it had not. */
  if (!path) {
    return {
      resolution: { kind: "unavailable", detail: "the orchestrator seat has no settled transcript path, so no host could be confirmed" },
      path,
      note: null,
    };
  }
  let target: string | null;
  try {
    target = await api.hostTarget(path);
  } catch (error) {
    return {
      resolution: { kind: "unavailable", detail: `the orchestrator host could not be probed: ${errorText(error)}` },
      path,
      note: null,
    };
  }
  if (target === null) {
    return {
      resolution: { kind: "unavailable", detail: "the recorded orchestrator conversation has no live host" },
      path,
      note: null,
    };
  }
  return { resolution: { kind: "resolved", conversationId, source: "project-seat" }, path, note: null };
}

function resolutionDetail(resolution: OrchestratorResolution): string {
  switch (resolution.kind) {
    case "missing-record":
      return "the project has no active orchestrator seat";
    case "stale-record":
      return "the seated orchestrator conversation no longer has a transcript on disk";
    case "unavailable":
      return resolution.detail;
    case "resolved":
      return "resolved";
  }
}

function errorText(error: unknown): string {
  return redactMonitorText(error instanceof Error ? error.message : "unknown error");
}

/** Newest conversations touched inside the window, capped. */
function conversationsInWindow(
  conversations: readonly ConversationSummary[],
  project: string | null,
  fromMs: number,
  limit: number,
): ConversationSummary[] {
  return conversations
    .filter((conversation) => (project ? conversation.project === project : true))
    .filter((conversation) => conversation.mtime * 1000 >= fromMs)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, limit);
}

/** The production claim: the viewer owns the lock file and hands out a token. */
async function apiClaim(api: ViewerApi): Promise<MonitorClaim> {
  let claim: Awaited<ReturnType<ViewerApi["claimRunLock"]>>;
  try {
    claim = await api.claimRunLock();
  } catch (error) {
    /* A lock that cannot be asked for is not a lock that is free. Skipping is
       the safe read: two monitors on one board create duplicate cards. */
    return { claimed: false, detail: `the monitor lock could not be claimed: ${errorText(error)}` };
  }
  if (!claim.claimed) return claim;
  return {
    claimed: true,
    release: async () => {
      try {
        await api.releaseRunLock(claim.token);
      } catch {
        /* The lock expires on its own; a failed release costs the next run a
           wait, never correctness. */
      }
    },
  };
}

export async function runConversationMonitor(deps: MonitorDeps, options: MonitorOptions = {}): Promise<MonitorRunReport> {
  const now = deps.now();
  const runId = deps.runId?.() ?? crypto.randomUUID();
  const appendRun = deps.appendRun ?? ((record: MonitorRunRecord) => deps.api.appendRun(record));
  const project = options.project?.trim() || null;
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const fromMs = now.getTime() - windowHours * 60 * 60 * 1000;
  const startedAt = now.toISOString();
  const base: Omit<MonitorRunRecord, "outcome" | "detail" | "finishedAt"> = {
    schemaVersion: 1,
    runId,
    startedAt,
    window: { from: new Date(fromMs).toISOString(), to: startedAt, hours: windowHours },
    scope: { project },
    orchestrator: { resolution: "unavailable", conversationId: null, delivered: false },
    scanned: { conversations: 0, operatorMessages: 0 },
    found: { total: 0, byState: emptyByState(), fingerprints: [] },
    created: [],
    skipped: [],
  };

  const finish = async (
    outcome: MonitorRunRecord["outcome"],
    detail: string | null,
    classified: ClassifiedRequest[] = [],
    message: string | null = null,
  ): Promise<MonitorRunReport> => {
    const record: MonitorRunRecord = { ...base, outcome, detail, finishedAt: deps.now().toISOString() };
    /* A run nobody could record is indistinguishable from a run that never
       happened — the exact ambiguity this monitor was built to remove — so the
       failure travels back with the report instead of being swallowed. */
    let audited = true;
    let auditError: string | null = null;
    try {
      await appendRun(record);
    } catch (error) {
      audited = false;
      auditError = `the run could not be audited: ${errorText(error)}`;
    }
    return { record: auditError ? { ...record, detail: [detail, auditError].filter(Boolean).join("; ") } : record, classified, message, audited };
  };

  const claim = await (deps.claim?.() ?? apiClaim(deps.api));
  if (!claim.claimed) return finish("skipped", claim.detail);

  try {
    if (!project) return await finish("failed", "a project is required to resolve the per-project orchestrator seat");

    /* 1. Who is the orchestrator, by durable seat — never by a path. */
    const { resolution, note: livenessNote } = await resolveOrchestrator(deps.api, project);
    base.orchestrator = {
      resolution: resolution.kind,
      conversationId: resolution.kind === "resolved" || resolution.kind === "stale-record" ? resolution.conversationId : null,
      delivered: false,
    };

    /* 2. What to read: the explicitly selected project's conversations. */
    let catalog: ConversationSummary[];
    try {
      catalog = await deps.api.conversations({ project, limit: 100 });
    } catch (error) {
      return await finish("failed", `the conversation catalog could not be read: ${errorText(error)}`);
    }
    const scanned = conversationsInWindow(catalog, project, fromMs, options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS);

    /* 3. Operator requests inside the window, told apart from everything else. */
    const requests: OperatorRequest[] = [];
    const seen = new Set<string>();
    let operatorMessages = 0;
    let unreadable = 0;
    for (const conversation of scanned) {
      let records;
      try {
        records = await deps.api.session(conversation.path);
      } catch {
        /* A transcript deleted or rotated mid-run is ordinary; it must not
           cost the run the conversations it already read. */
        unreadable += 1;
        continue;
      }
      operatorMessages += records.filter((record) => {
        if (record.kind !== "message" || record.role !== "user" || !record.ts) return false;
        const at = Date.parse(record.ts);
        return Number.isFinite(at) && at >= fromMs && at <= now.getTime();
      }).length;
      for (const request of operatorRequestsFrom(records, conversation.project, { fromMs, toMs: now.getTime() })) {
        if (seen.has(request.fingerprint)) continue;
        seen.add(request.fingerprint);
        requests.push(request);
      }
    }
    base.scanned = { conversations: scanned.length, operatorMessages };

    /* 4. What the machine already tracks. Correlation without this would make
          every request look untracked, so a source that refuses fails the run
          rather than flooding the board. */
    let evidence: EvidenceItem[];
    let githubNote: string | null = null;
    try {
      const [tasks, pipelines, flows] = await Promise.all([deps.api.tasks(), deps.api.pipelines(), deps.api.flows()]);
      evidence = [...evidenceFromTasks(tasks), ...evidenceFromPipelines(pipelines), ...evidenceFromFlows(flows)];
    } catch (error) {
      return await finish("failed", `tracked work could not be read: ${errorText(error)}`);
    }
    if (deps.github) {
      try {
        evidence = [...evidence, ...evidenceFromGithub(await deps.github())];
      } catch (error) {
        githubNote = `pull request and issue correlation was unavailable: ${errorText(error)}`;
      }
    }

    /* 5. Classify, then materialize only the genuine gaps. */
    const classifyOptions = { now, stallAfterMs: options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS };
    const classified = requests.map((request) => classifyRequest(request, evidence, classifyOptions));
    const byState = emptyByState();
    for (const entry of classified) byState[entry.state] += 1;
    base.found = { total: classified.length, byState, fingerprints: classified.map((entry) => entry.request.fingerprint) };

    const created: MonitorCreation[] = [];
    const skipped: MonitorSkip[] = [];
    for (const entry of classified) {
      if (entry.match?.item.monitorRef === entry.request.fingerprint) {
        skipped.push({ fingerprint: entry.request.fingerprint, reason: "already-tracked" });
      }
    }
    const budget = options.maxCards ?? DEFAULT_MAX_CARDS;
    for (const entry of classified.filter((candidate) => MATERIALIZED_STATES.includes(candidate.state))) {
      if (options.dryRun) {
        skipped.push({ fingerprint: entry.request.fingerprint, reason: "dry-run" });
        continue;
      }
      if (created.length >= budget) {
        skipped.push({ fingerprint: entry.request.fingerprint, reason: "card-budget" });
        continue;
      }
      try {
        const card = await deps.api.createCard({
          project: entry.request.project,
          text: monitorCardText(entry),
          clientRequestId: monitorClientRequestId(entry.request.fingerprint),
        });
        created.push({ fingerprint: entry.request.fingerprint, taskId: card.taskId, state: entry.state });
      } catch (error) {
        base.created = created;
        base.skipped = skipped;
        return await finish("failed", `a board card could not be created: ${errorText(error)}`, classified);
      }
    }

    /* 6. An unresolvable orchestrator is itself reportable work. An alert card
          still open covers the condition, so it surfaces once rather than every
          half hour; one the operator marked done means they believe it handled,
          and a condition that outlived that deserves a fresh card — hence the
          run-scoped request id, which never replays onto the closed one. */
    if (resolution.kind !== "resolved" && !options.dryRun) {
      const alreadyRaised = evidence.some((item) => item.monitorRef === ORCHESTRATOR_ALERT_REF && item.state !== "terminal")
        || created.some((entry) => entry.fingerprint === ORCHESTRATOR_ALERT_REF);
      const alertProject = project ?? scanned[0]?.project ?? catalog[0]?.project ?? null;
      if (!alreadyRaised && alertProject) {
        try {
          const card = await deps.api.createCard({
            project: alertProject,
            text: orchestratorAlertCardText(resolutionDetail(resolution), startedAt),
            clientRequestId: monitorClientRequestId(`${ORCHESTRATOR_ALERT_REF}:${runId}`),
          });
          created.push({ fingerprint: ORCHESTRATOR_ALERT_REF, taskId: card.taskId, state: "orchestrator-alert" });
        } catch {
          /* The failure below already reports the condition; a board write
             that also fails must not mask it. */
        }
      }
    }
    base.created = created;
    base.skipped = skipped;

    /* 7. Report — to the orchestrator when there is one, always to the journal. */
    const createdByFingerprint = new Map(created.map((entry) => [entry.fingerprint, entry] as const));
    const notes = [githubNote, livenessNote, unreadable > 0 ? `${unreadable} transcript(s) were unreadable this run` : null]
      .filter(Boolean).join("; ") || null;
    const provisional: MonitorRunRecord = {
      ...base,
      outcome: resolution.kind === "resolved" ? "clean" : "failed",
      detail: resolution.kind === "resolved" ? notes : `no live orchestrator could be resolved — ${resolutionDetail(resolution)}`,
      finishedAt: deps.now().toISOString(),
    };
    const message = renderMonitorReport({ record: provisional, classified, createdByFingerprint });

    if (resolution.kind !== "resolved") {
      /* The message is returned unsent: the caller may log it, but nothing is
         delivered into a conversation nobody is holding. */
      return await finish("failed", provisional.detail, classified, message);
    }
    const worthSaying = classified.length > 0 || created.length > 0 || options.deliverWhenEmpty === true;
    if (!options.dryRun && worthSaying) {
      let delivery: Awaited<ReturnType<ViewerApi["deliver"]>>;
      try {
        delivery = await deps.api.deliver({ conversationId: resolution.conversationId, text: message, clientMessageId: `monitor-741-${runId}` });
      } catch (error) {
        return await finish("failed", `the report could not be delivered to the orchestrator: ${errorText(error)}`, classified, message);
      }
      /* The probe said a host was there, and the send booted one anyway. The
         monitor woke a session it had no business waking, and — worse — the
         conversation it was addressing was not live after all. A run that had
         to resurrect its audience did not deliver in the sense that matters,
         so it does not get to finish clean. */
      if (delivery.spawned) {
        base.orchestrator = { ...base.orchestrator, delivered: false };
        return await finish(
          "failed",
          "the send had to resume the orchestrator host, so the conversation had no live audience when the report was written",
          classified,
          message,
        );
      }
      base.orchestrator = { ...base.orchestrator, delivered: true };
    }
    return await finish("clean", notes, classified, message);
  } finally {
    await claim.release();
  }
}
