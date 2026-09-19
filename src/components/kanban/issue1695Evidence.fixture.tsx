import { createRoot } from "react-dom/client";

import { cancelArrivalPulse, startArrivalPulse } from "@/components/attention/arrivalPulse";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { runFocusTransaction } from "@/components/attention/navigate";
import { Viewer } from "@/components/Viewer";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import { admissionSnapshot } from "@/lib/tasks/groupHide";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * The real Viewer on the kanban face (#1695), over invented content equivalent
 * to the approved prototype's fixture (`prototypes/kanban-board/fixture.js`):
 * the same tasks in the same columns, the branch-retry-review pipeline, the
 * eight-stage chain, the simple chain parked on a decision, a forward fail
 * branch, and plain conversation members; the project's orchestrator seat and
 * short transcripts for its conversations, one of them empty (K3). With
 * `?scenario=editing` (K4b) three groups start hidden, as in the prototype's
 * hidden-tray frame, a conversation is closed on the board, and the
 * orchestrator's conversation sits on a task an agent hid before the seat was
 * designated. With `?scenario=stages` (K5b) the pipelines scenario also
 * answers the pipeline route: reads, stage prompt overrides and the pipeline
 * actions, with hooks for a refusal, a stage that starts during a save, and
 * a prompt another client saves. With `?scenario=accounts` (K6) the stages
 * scenario also answers the account routes: the accounts and their limits, the
 * project's accounts, a conversation's account switch and a stage's account,
 * with hooks for the migration record, a committed switch, a refusal and a lost
 * answer. Every
 * request the Viewer makes is answered here; nothing reaches a server, a store
 * or a state directory. Driven by the `issue1695*.browser.test.tsx` files.
 */

const PROJECT = "atlas";
const SCENARIO = new URLSearchParams(location.search).get("scenario");
const EDITING = SCENARIO === "editing";
/* K5a: the pipelines' review stages are bound to review flows with rounds. K5b's Stages build on them. */
/* #1839: the same tier scenario, with the windows arriving the way the provider
   actually files them — under codenamed buckets, one of them carrying the
   provider's own human label and one carrying none. */
const CODENAME_TIERS = SCENARIO === "tier-codename";
const TIER_LIMITS = SCENARIO === "tier-limits" || CODENAME_TIERS;
const ACCOUNTS = SCENARIO === "accounts" || TIER_LIMITS;
const STAGES = SCENARIO === "stages" || ACCOUNTS;
const PIPELINES = SCENARIO === "pipelines" || STAGES;
/* #1846: `&runtime=structured` answers the runtime snapshot with one structured session, for the running
   verify conversation, so its composer's runtime pill and the board's account chip both draw. */
const STRUCTURED = new URLSearchParams(location.search).get("runtime") === "structured";
/* Review round 2 of #1712: a conversation no card holds, whose reader takes the window. */
const LOOSE = SCENARIO === "loose";
/* #1765: one task carrying five pipelines — two running, three completed — so
   a card's rows can be read for what each pipeline actually does. */
const MANY = SCENARIO === "issue1765";
/* #1743: one task whose pipelines exercise the whole identity/edge vocabulary —
   a fail edge fired twice of three, one whose budget is spent, mixed engines,
   all five effort levels, a long uncatalogued model, a stage edited after its
   launch, and a stage that has never started. */
const MARKS = SCENARIO === "issue1743";
/* #1820: the Overview draws the SAME board over every project, filtered to the
   cards a worker is working on right now. Two invented projects join `atlas`
   so the shared columns can be read across three, each bringing one card with
   a worker on it and one with nobody. `issue1820-empty` answers every route
   with nothing, which is the Overview's first run. */
/* `issue1820-quiet` is the same installation with nobody working in it: the
   Overview's most common state, where the board is narrowed to nothing by its
   own permanent filter and no search was ever typed. */
const OVERVIEW_QUIET = SCENARIO === "issue1820-quiet";
const OVERVIEW_SCOPE = SCENARIO === "issue1820" || OVERVIEW_QUIET;
const OVERVIEW_EMPTY = SCENARIO === "issue1820-empty";
const LEDGER = "acme-ledger";
const MESH = "river-mesh";
/* #1798: one task carrying the lanes a return arc has to tell apart — a fail
   edge at rest, one that fired once and is carrying the work back right now,
   one whose budget is spent with the last return still in flight, one where
   the spent budget already stopped the lane, and a lane with two fail edges
   into the same stage. */
const ARCS = SCENARIO === "issue1798";
const flowOf = (id: string) => (PIPELINES ? { flowId: id } : {});
const now = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1_000).toISOString();
const MIN = 60;
const REV = (n: number) => `task-v1:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function conversation(id: string, title: string, over: Record<string, unknown> = {}): FileEntry {
  return {
    path: `/repo/${id}.jsonl`, root: "claude-projects", name: `${id}.jsonl`, project: PROJECT, title, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: now - 15 * MIN, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
    pendingQuestion: null, waitingInput: null, conversationId: `conversation_${id}`,
    ...over,
  } as unknown as FileEntry;
}
const working = (over: Record<string, unknown> = {}) => ({
  activity: "live", proc: "running", pid: 4_401, mtime: now - 30,
  authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
  lastTurn: { startedAt: (now - 400) * 1_000, endedAt: null },
  ...over,
});

const role = (roleId: string, engine = "claude") => ({ roleId, engine, model: engine === "claude" ? "opus" : "gpt-5.6", effort: "high", access: "read-write", promptScaffold: null });
/* The approved prototype's stage prompts, behind the wiring token the engine substitutes. */
const PROMPTS: Record<string, string> = {
  "p-upload:plan": "{{task}}\n\nRead the upload path end to end and write the plan: chunk size, resume token, and what the UI must survive.",
  "p-upload:build-api": "{{prev.output}}\n\nImplement the chunked upload endpoint with a resume token. Keep the old endpoint working until the UI switches.",
  "p-upload:review-api": "{{prev.output}}\n\nReview the API diff against the plan. Block on anything that loses a chunk on retry.",
  "p-upload:build-ui": "{{prev.output}}\n\nBuild the progress UI on the new endpoint. A reload must pick the upload up where it stopped.",
  "p-upload:review-ui": "{{prev.output}}\n\nReview the UI diff. Check the reload path and the error states on a 390 px screen.",
  "p-upload:verify": "{{prev.output}}\n\nUpload a 1.2 GB file, kill the tab at 40 %, reopen, and confirm it resumes. Fail with the exact step that broke.",
  "p-upload:docs": "{{prev.output}}\n\nDocument the resume token and the new limits in the API guide.",
  "p-upload:merge": "{{prev.output}}\n\nRebase on main, run the touched tests by path, and merge.",
  "p-links:review": "{{prev.output}}\n\nCheck both anchors against the published notes before approving.",
  "p-search:merge": "{{prev.output}}\n\nMerge once the alias swap is verified under traffic.",
};
function stage(id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) {
  return { id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over };
}
function attempt(n: number, state: string, file: FileEntry | null, over: Record<string, unknown> = {}) {
  return {
    n, state, effectiveRole: role("builder"), launchId: file ? `launch-${file.name}` : null, conversationId: file?.conversationId ?? null,
    sessionId: null, agentPath: file?.path ?? null, paneId: null, flowId: null, startedAt: iso(60 * MIN), completedAt: null,
    input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
  };
}
function pipeline(id: string, task: string, taskId: string, state: string, stages: unknown[], runs: unknown[], cursor: unknown, over: Record<string, unknown> = {}): Pipeline {
  return {
    id, task, taskIds: [taskId], project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `pipeline/${id}`,
    baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages, runs, cursor, state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: iso(8 * 60 * MIN), closedAt: null, ...over,
  } as unknown as Pipeline;
}

const files: FileEntry[] = [];
const add = (file: FileEntry) => { files.push(file); return file; };

/* t-search: implement → review (review loop) → verify → merge, with verify's fail edge back to implement. */
const searchImpl1 = add(conversation("search-impl-1", "Keep the old index serving until the new one answers", { mtime: now - 180 * MIN }));
const searchImpl2 = add(conversation("search-impl-2", "Swap the alias only after the warm-up query returns", { mtime: now - 70 * MIN, engine: "claude" }));
const searchRev = add(conversation("search-rev", "Review the warm-up gate", { mtime: now - 41 * MIN, engine: "codex", model: "gpt-5.6" }));
const searchVer1 = add(conversation("search-ver-1", "Results empty for 40 s after the swap", { mtime: now - 90 * MIN }));
const searchVer2 = add(conversation("search-ver-2", "Re-running the rebuild with traffic", working({ plan: { current: "Re-running the rebuild with traffic" } })));

/** The runtime snapshot `&runtime=structured` answers: the verify conversation on a structured host, mid-turn. */
function structuredSnapshot() {
  return {
    schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
    sessions: [{
      conversationId: searchVer2.conversationId, sessionKey: { engine: "claude", sessionId: "search-ver-2-session" }, hostKind: "claude-broker", host: "hosted",
      turn: "running", provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: "default",
      parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: searchVer2.path,
      capabilities: { steer: false, structuredAttention: true }, activeTurnId: "turn-1", pendingReconfigure: null,
    }],
    attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
  };
}
/* t-upload: an eight-stage chain, the UI builder working. */
const uploadPlan = add(conversation("upload-plan", "Plan: 8 MB chunks, resume token per file", { mtime: now - 8 * 60 * MIN }));
const uploadApi = add(conversation("upload-api", "Endpoint and resume token in place", { mtime: now - 6 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const uploadRevApi = add(conversation("upload-rev-api", "Round 2 approved", { mtime: now - 4 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const uploadUi = add(conversation("upload-ui", "Wiring the resume banner", working({ plan: { current: "Wiring the resume banner" } })));
/* t-export: two plain conversations. */
const exportImpl = add(conversation("export-impl", "Implementer: simplify the export settings", working({ plan: { current: "Writing the preset model" } })));
const exportExplore = add(conversation("export-explore", "Explorer: list every export toggle", { mtime: now - 120 * MIN, engine: "codex", model: "gpt-5.6" }));
/* t-links: a simple chain parked on a decision. */
const linksImpl = add(conversation("links-impl", "Which of the two anchors should win?", { mtime: now - 17 * MIN, engine: "codex", model: "gpt-5.6", waitingInput: { since: now - 17 * MIN } }));
/* t-limits: build failed, the fail edge started diagnose, which needs a decision. */
const limitsBuild = add(conversation("limits-build", "Rate limited before the verdict", { mtime: now - 3 * 24 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const limitsDiag = add(conversation("limits-diag", "Retry on another account, or wait for the reset?", { mtime: now - 3 * 24 * 60 * MIN + 20 * MIN }));
/* t-auth and t-pending: one conversation each. */
const authImpl = add(conversation("auth-impl", "Implementer: passkey sign-in", { mtime: now - 20 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
/* A transcript with nothing in it yet: its reader settles on the empty state. */
const pendingWorker = add(conversation("pending-worker", "Worker waiting for a seat", { mtime: now - 6 * MIN, size: 0 }));
/* t-attach: done by decision while its verify stage still runs; t-compact: completed. */
const attachBuild = add(conversation("attach-build", "Streams attachments in 256 KB chunks", { mtime: now - 13 * 60 * MIN, engine: "codex", model: "gpt-5.6" }));
const attachVerify = add(conversation("attach-verify", "Re-running the phone matrix", working({ plan: { current: "Re-running the phone matrix" } })));
/* Aged out of the scheme window: its stage chip must still open it, by identity. */
const compactBuild = conversation("compact-build", "Folded finished stages into one row", { mtime: now - 3 * 24 * 60 * MIN });
const compactRev = add(conversation("compact-rev", "Approved", { mtime: now - 2 * 24 * 60 * MIN - 90 * MIN, engine: "codex", model: "gpt-5.6" }));
const compactVer = add(conversation("compact-ver", "Board frames match at five widths", { mtime: now - 2 * 24 * 60 * MIN }));
/* The project's orchestrator: seated above the board, and, as in production,
   also a conversation on it ("Not on a task" here). Its one composer is the
   seat's. */
const orchestrator = add(conversation("orchestrator", "Orchestrator for atlas", working({ plan: { current: "Watching the search fix" } })));
/* K4b: the merge task's implementer, and a spike closed on the board. */
const mergeImpl = EDITING ? add(conversation("merge-impl", "Implementer: merge the queue adapter", { mtime: now - 26 * 60 * MIN })) : null;
const oldSpike = EDITING ? add(conversation("old-spike", "Spike: a virtualized Done column", { mtime: now - 5 * 24 * 60 * MIN })) : null;
/* K5a: a helper conversation the search builder brought in, and a review that took five rounds. */
/* #1820's two other projects. Working evidence is the one the board's «N
   working» counter reads: a live transcript whose turn never closed. */
const ledgerBuild = OVERVIEW_SCOPE ? add(conversation("ledger-build", "Reconciling the ledger export", { project: LEDGER, ...working({ plan: { current: "Reconciling the ledger export" } }) })) : null;
const ledgerQuiet = OVERVIEW_SCOPE ? add(conversation("ledger-quiet", "Archived last quarter", { project: LEDGER, mtime: now - 4 * 60 * MIN, lastTurn: { startedAt: (now - 5 * 60 * MIN) * 1_000, endedAt: (now - 4 * 60 * MIN) * 1_000 } })) : null;
const meshAsk = OVERVIEW_SCOPE ? add(conversation("mesh-ask", "Which of the two meshes keeps the old ids?", { project: MESH, engine: "codex", model: "gpt-5.6", mtime: now - 11 * MIN, waitingInput: { since: now - 11 * MIN } })) : null;
const meshQuiet = OVERVIEW_SCOPE ? add(conversation("mesh-quiet", "Wrote the migration notes", { project: MESH, mtime: now - 6 * 60 * MIN })) : null;

const searchHelper = PIPELINES ? add(conversation("search-helper", "Helper: profile the index warm-up", { mtime: now - 50 * MIN })) : null;
const roundsBuild = PIPELINES ? add(conversation("rounds-build", "Builder: rework the retry banner", { mtime: now - 3 * 60 * MIN })) : null;
const roundsReview = PIPELINES ? add(conversation("rounds-review", "Reviewer: fifth pass on the retry banner", working({ plan: { current: "Reading the fifth revision" } }))) : null;
/* K5b: the conversation the release-notes Review gets when it starts during a save. */
const searchRevFirst = STAGES ? add(conversation("search-rev-1", "Round 2 approved", { mtime: now - 120 * MIN, engine: "codex", model: "gpt-5.6" })) : null;
const exportReview = LOOSE ? add(conversation("export-review", "Reviewer: two presets share a name", { mtime: now - 12 * MIN, engine: "codex", model: "gpt-5.6" })) : null;
const linksReview = STAGES ? add(conversation("links-review", "Reviewer: both anchors against the published notes", working({ engine: "codex", model: "gpt-5.6", plan: { current: "Reading the published notes" } }))) : null;

/* #1765: each of the five pipelines on t-many gets its own pair of stages and
   its own conversations, so no row borrows another's identity. */
const manyStages = (critique: string, fix: string) => [stage(critique, "reviewer", fix), stage(fix, "builder", null)];
const manyPipelines: Pipeline[] = MANY ? ([
  ["p-many-pills", "Name every pipeline row on a task card", "running", null, ["critique", "fix"]],
  ["p-many-drawers", "Remove the legacy drawers under the board columns", "running", null, ["diagnose", "cut"]],
  ["p-many-pill", "Take the floating waiting pill out of the corner", "completed", 40, ["critique", "fix"]],
  ["p-many-collapse", "Fold the completed pipelines of a task behind their count", "completed", 6 * 60, ["review-plan", "apply"]],
  ["p-many-report", "Read a stage report as role, outcome and age", "completed", 26 * 60, ["critique", "repair"]],
] as const).map(([id, task, state, closedAgo, [first, second]]) => {
  const opened = add(conversation(`${id}-1`, `Opened ${task}`, { mtime: now - 90 * MIN, engine: "codex", model: "gpt-5.6" }));
  const closing = add(conversation(`${id}-2`, `Finished ${task}`, state === "running"
    ? working({ plan: { current: task } })
    : { mtime: now - 30 * MIN }));
  return pipeline(id, task, "t-many", state, manyStages(first, second), [
    { stageId: first, attempts: [attempt(1, "passed", opened, { startedAt: iso(120 * MIN) })] },
    { stageId: second, attempts: [attempt(1, state === "running" ? "running" : "passed", closing, { startedAt: iso(80 * MIN), activatedBy: { stageId: first, attempt: 1, edge: "pass" } })] },
  ], state === "running" ? { stageId: second, state: "running", input: null, activatedBy: null } : null, {
    closedAt: closedAgo === null ? null : iso(closedAgo * MIN),
    /* The last completed pipeline carries a stage report: role, outcome, age —
       and no conversation id anywhere on the card. */
    ...(id === "p-many-report"
      ? { stageReports: [{ seq: 1, at: iso(30 * MIN), actor: { kind: "agent", role: "builder", conversationId: closing.conversationId }, stageId: second, attempt: 1, status: "pass", findings: 0, replaces: null, summary: "Read the line as words." }] }
      : {}),
  });
}) : [];

/* #1743. `role()` gives every stage the engine default; these stages name their
   own engine, model and effort, and their attempts record what actually ran. */
const runRole = (roleId: string, engine: string, model: string, effort: string) =>
  ({ roleId, engine, model, effort, access: "read-write", promptScaffold: null });
const marksStage = (id: string, roleId: string, next: string | null, engine: string, model: string, effort: string, over: Record<string, unknown> = {}) =>
  stage(id, roleId, next, { effectiveRole: runRole(roleId, engine, model, effort), ...over });

const marksPipelines: Pipeline[] = MARKS ? (() => {
  const conv = (id: string, title: string, over: Record<string, unknown> = {}) => add(conversation(id, title, over));
  const plan = conv("marks-plan", "Plan the retry banner", { mtime: now - 300 * MIN, model: "fable" });
  const build1 = conv("marks-build-1", "First pass at the banner", { mtime: now - 260 * MIN, model: "sonnet" });
  const build2 = conv("marks-build-2", "Second pass after the first critique", { mtime: now - 180 * MIN, model: "sonnet" });
  const build3 = conv("marks-build-3", "Third pass after the second critique", working({ model: "sonnet", plan: { current: "Rewriting the banner copy" } }));
  const crit1 = conv("marks-crit-1", "Sent it back: the banner hides the retry", { mtime: now - 220 * MIN });
  const crit2 = conv("marks-crit-2", "Sent it back again: still no count", { mtime: now - 140 * MIN });
  const spentBuild = conv("marks-spent-build", "Reworked the limit notice", { mtime: now - 90 * MIN });
  const spentRev = conv("marks-spent-rev", "Out of returns", { mtime: now - 40 * MIN, engine: "codex", model: "gpt-6-astra" });
  return [
    /* The fail edge fired twice of three: a circled 2 on the arrow, one return left. */
    pipeline("p-marks", "Rework the retry banner until the critique passes", "t-marks", "running", [
      marksStage("plan", "architect", "build", "claude", "fable", "low"),
      /* Edited to Codex after it last ran on Claude: the node keeps the launched
         values and marks that the next attempt differs. */
      marksStage("build", "builder", "critique", "codex", "gpt-5.6-terra", "medium"),
      marksStage("critique", "architect", "verify", "claude", "opus", "high", { onFail: { to: "build", maxRounds: 3 } }),
      marksStage("verify", "verifier", "ship", "codex", "gpt-6-astra", "xhigh"),
      /* Never started: its configuration reads as configuration, muted. */
      marksStage("ship", "cleaner", null, "claude", "claude-opus-5-20260101-preview", "max"),
    ], [
      { stageId: "plan", attempts: [attempt(1, "passed", plan, { effectiveRole: runRole("architect", "claude", "fable", "low"), startedAt: iso(300 * MIN) })] },
      { stageId: "build", attempts: [
        attempt(1, "passed", build1, { effectiveRole: runRole("builder", "claude", "sonnet", "medium"), startedAt: iso(260 * MIN), activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } }),
        attempt(2, "passed", build2, { effectiveRole: runRole("builder", "claude", "sonnet", "medium"), startedAt: iso(200 * MIN), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" } }),
        attempt(3, "running", build3, { effectiveRole: runRole("builder", "claude", "sonnet", "medium"), startedAt: iso(120 * MIN), activatedBy: { stageId: "critique", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "critique", attempts: [
        attempt(1, "failed", crit1, { effectiveRole: runRole("architect", "claude", "opus", "high"), startedAt: iso(220 * MIN), activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", crit2, { effectiveRole: runRole("architect", "claude", "opus", "high"), startedAt: iso(140 * MIN), activatedBy: { stageId: "build", attempt: 2, edge: "pass" } }),
      ] },
    ], { stageId: "build", state: "running", input: null, activatedBy: null }),
    /* The same edge with nothing left: two of two used, drawn as exhausted. */
    pipeline("p-marks-spent", "Show the account limit reset on the card", "t-marks", "running", [
      marksStage("fix", "builder", "review", "claude", "opus", "max"),
      marksStage("review", "verifier", null, "codex", "gpt-6-astra", "xhigh", { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", spentBuild, { effectiveRole: runRole("builder", "claude", "opus", "max"), startedAt: iso(90 * MIN) }),
        attempt(2, "passed", spentBuild, { effectiveRole: runRole("builder", "claude", "opus", "max"), startedAt: iso(70 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(3, "running", spentBuild, { effectiveRole: runRole("builder", "claude", "opus", "max"), startedAt: iso(50 * MIN), activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [
        attempt(1, "failed", spentRev, { effectiveRole: runRole("verifier", "codex", "gpt-6-astra", "xhigh"), startedAt: iso(80 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", spentRev, { effectiveRole: runRole("verifier", "codex", "gpt-6-astra", "xhigh"), startedAt: iso(60 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
  ];
})() : [];

/* #1798. Six lanes on one card, each with the fail edge in one state, so the
   arcs under the rows can be read side by side at any width: at rest, fired
   once with the returned stage running because of it, a spent budget, a lane
   the spent budget stopped, and two edges into one target. Their stages are
   short on purpose — the row of a real card is 220-264 px wide, and the
   one-line row with its arcs has to be readable in the same frame. The sixth
   is the length a real lane usually has, four stages, and wraps everywhere the
   board is not a 1920 px screen: that is the row the suffix is drawn on, and
   it is the common case rather than the narrow one. */
const arcPipelines: Pipeline[] = ARCS ? (() => {
  const conv = (id: string, title: string, over: Record<string, unknown> = {}) => add(conversation(id, title, over));
  const restFix = conv("arc-rest-fix", "Draft the empty-state copy", { mtime: now - 70 * MIN });
  const restCrit = conv("arc-rest-crit", "Reading the draft", working({ plan: { current: "Reading the draft" } }));
  const firedFix = conv("arc-fired-fix", "Second pass after the review sent it back", working({ plan: { current: "Rewriting the summary row" } }));
  const firedRev = conv("arc-fired-rev", "Sent it back: the summary row still lies", { mtime: now - 55 * MIN, engine: "codex", model: "gpt-6-astra" });
  const spentFix = conv("arc-spent-fix", "Last return: the limit notice again", working({ plan: { current: "Rewriting the limit notice" } }));
  const spentRev = conv("arc-spent-rev", "Sent it back: the notice still rounds the reset", { mtime: now - 40 * MIN, engine: "codex", model: "gpt-6-astra" });
  const parkFix = conv("arc-park-fix", "Third pass on the reset time", { mtime: now - 50 * MIN });
  const parkRev = conv("arc-park-rev", "Out of returns: the reset time is still wrong", { mtime: now - 15 * MIN, engine: "codex", model: "gpt-6-astra" });
  const twoFix = conv("arc-two-fix", "Third pass on the picker", working({ plan: { current: "Reworking the picker" } }));
  const twoCrit = conv("arc-two-crit", "Sent it back: the picker hides the default", { mtime: now - 140 * MIN });
  const twoRev = conv("arc-two-rev", "Sent it back: the default is still not marked", { mtime: now - 90 * MIN, engine: "codex", model: "gpt-6-astra" });
  const longImpl = conv("arc-long-impl", "Second pass after the verifier sent it back", working({ plan: { current: "Re-reading the column widths" } }));
  const longRev = conv("arc-long-rev", "Read the first pass", { mtime: now - 120 * MIN });
  const longVer = conv("arc-long-ver", "Sent it back: two columns still clip", { mtime: now - 80 * MIN, engine: "codex", model: "gpt-6-astra" });
  return [
    /* At rest: three stages, one fail edge, nothing used. The arc is faint and
       wordless — the budget is in its tooltip only. */
    pipeline("p-arc-rest", "Write the empty state of the pipelines list", "t-arcs", "running", [
      stage("fix", "builder", "critique"),
      stage("critique", "architect", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 3 } }),
    ], [
      { stageId: "fix", attempts: [attempt(1, "passed", restFix, { startedAt: iso(70 * MIN) })] },
      { stageId: "critique", attempts: [attempt(1, "running", restCrit, { startedAt: iso(20 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } })] },
    ], { stageId: "critique", state: "running", input: null, activatedBy: null }),
    /* Fired once of three, and the stage it returned to is running BECAUSE of
       it: the arc is the live one. */
    pipeline("p-arc-fired", "Make the summary row say what actually ran", "t-arcs", "running", [
      stage("fix", "builder", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 3 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", firedFix, { startedAt: iso(120 * MIN) }),
        attempt(2, "running", firedFix, { startedAt: iso(40 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [attempt(1, "failed", firedRev, { startedAt: iso(60 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } })] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
    /* Two of two used, and the lane is still alive: the last return is in
       flight, so the arc and its counter are danger while the work runs. The
       sentence is about what a FURTHER failure would cost. */
    pipeline("p-arc-spent", "Show the account limit reset on the card", "t-arcs", "running", [
      stage("fix", "builder", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", spentFix, { startedAt: iso(150 * MIN) }),
        attempt(2, "passed", spentFix, { startedAt: iso(110 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(3, "running", spentFix, { startedAt: iso(30 * MIN), activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [
        attempt(1, "failed", spentRev, { startedAt: iso(130 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", spentRev, { startedAt: iso(80 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
    /* The same budget, spent, with the source failed once more: the engine had
       nothing left to return and parked the lane on the failing stage. This is
       the state a red arc is most often read in, and the one whose sentence
       says what happened rather than what a further failure would cost. */
    pipeline("p-arc-parked", "Say when the account limit resets", "t-arcs", "needs_decision", [
      stage("fix", "builder", "review"),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", parkFix, { startedAt: iso(220 * MIN) }),
        attempt(2, "passed", parkFix, { startedAt: iso(180 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
        attempt(3, "passed", parkFix, { startedAt: iso(120 * MIN), activatedBy: { stageId: "review", attempt: 2, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [
        attempt(1, "failed", parkRev, { startedAt: iso(200 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "failed", parkRev, { startedAt: iso(150 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
        attempt(3, "needs_decision", parkRev, { startedAt: iso(90 * MIN), activatedBy: { stageId: "fix", attempt: 3, edge: "pass" } }),
      ] },
    ], { stageId: "review", state: "running", input: null, activatedBy: null }),
    /* Two fail edges into one target: two arcs at two depths, neither crossing
       a pill and neither crossing the other. */
    pipeline("p-arc-two", "Mark the default account in the picker", "t-arcs", "running", [
      stage("fix", "builder", "critique"),
      stage("critique", "architect", "review", { onFail: { to: "fix", maxRounds: 3 } }),
      stage("review", "verifier", null, { onFail: { to: "fix", maxRounds: 2 } }),
    ], [
      { stageId: "fix", attempts: [
        attempt(1, "passed", twoFix, { startedAt: iso(200 * MIN) }),
        attempt(2, "passed", twoFix, { startedAt: iso(150 * MIN), activatedBy: { stageId: "critique", attempt: 1, edge: "fail" } }),
        attempt(3, "running", twoFix, { startedAt: iso(70 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "fail" } }),
      ] },
      { stageId: "critique", attempts: [
        attempt(1, "failed", twoCrit, { startedAt: iso(170 * MIN), activatedBy: { stageId: "fix", attempt: 1, edge: "pass" } }),
        attempt(2, "passed", twoCrit, { startedAt: iso(130 * MIN), activatedBy: { stageId: "fix", attempt: 2, edge: "pass" } }),
      ] },
      { stageId: "review", attempts: [attempt(1, "failed", twoRev, { startedAt: iso(100 * MIN), activatedBy: { stageId: "critique", attempt: 2, edge: "pass" } })] },
    ], { stageId: "fix", state: "running", input: null, activatedBy: null }),
    /* Four stages, which is the ordinary length of a real lane. A row this long
       wraps in every column the board actually gives it short of a 1920 px
       screen, so the suffix on the failing pill — not the arc — is what most
       lanes draw, and the wide frames have to show it. Its edge fired once and
       the return is in flight, which is the reading the suffix has to keep
       apart from a return that is over. */
    pipeline("p-arc-long", "Keep every column legible while a lane runs", "t-arcs", "running", [
      stage("implement", "builder", "review"),
      stage("review", "reviewer", "verify"),
      stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 3 } }),
      stage("merge", "cleaner", null),
    ], [
      { stageId: "implement", attempts: [
        attempt(1, "passed", longImpl, { startedAt: iso(160 * MIN) }),
        attempt(2, "running", longImpl, { startedAt: iso(35 * MIN), activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }),
      ] },
      { stageId: "review", attempts: [attempt(1, "passed", longRev, { startedAt: iso(120 * MIN), activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } })] },
      { stageId: "verify", attempts: [attempt(1, "failed", longVer, { startedAt: iso(80 * MIN), activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
    ], { stageId: "implement", state: "running", input: null, activatedBy: null }),
  ];
})() : [];

const pipelines: Pipeline[] = [
  ...arcPipelines,
  ...marksPipelines,
  ...manyPipelines,
  pipeline("p-search", "Restore search results after the index rebuild", "t-search", "running",
    [stage("implement", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }), stage("merge", "cleaner", null)],
    [
      { stageId: "implement", attempts: [
        attempt(1, "passed", searchImpl1),
        attempt(2, "passed", searchImpl2, { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }),
        /* Lineage-adopted: the engine copies the source attempt's provenance onto it. */
        ...(searchHelper ? [attempt(3, "passed", searchHelper, { historical: true, activatedBy: { stageId: "verify", attempt: 1, edge: "fail" }, startedAt: iso(55 * MIN) })] : []),
      ] },
      { stageId: "review", attempts: [attempt(1, "passed", searchRev, { ...flowOf("flow-search-review"), reviewFlowSync: { generation: "g1", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "failed", searchVer1), attempt(2, "running", searchVer2, { activatedBy: { stageId: "review", attempt: 1, edge: "pass" } })] },
    ],
    { stageId: "verify", state: "running", input: null, activatedBy: null }),
  pipeline("p-upload", "Redesign attachment upload for large files", "t-upload", "running",
    [stage("plan", "architect", "build-api"), stage("build-api", "builder", "review-api"), stage("review-api", "reviewer", "build-ui"), stage("build-ui", "builder", "review-ui"), stage("review-ui", "reviewer", "verify"), stage("verify", "verifier", "docs", { onFail: { to: "build-ui", maxRounds: 2 } }), stage("docs", "builder", "merge"), stage("merge", "cleaner", null)],
    [
      { stageId: "plan", attempts: [attempt(1, "passed", uploadPlan)] },
      { stageId: "build-api", attempts: [attempt(1, "passed", uploadApi)] },
      { stageId: "review-api", attempts: [attempt(1, "passed", uploadRevApi, { ...flowOf("flow-upload-review-api"), reviewFlowSync: { generation: "g2", roundCount: 2, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "build-ui", attempts: [attempt(1, "running", uploadUi)] },
    ],
    { stageId: "build-ui", state: "running", input: null, activatedBy: null }),
  pipeline("p-links", "Repair old links in the release notes", "t-links", "needs_decision",
    [stage("implement", "builder", "review"), stage("review", "reviewer", null)],
    [{ stageId: "implement", attempts: [attempt(1, "needs_decision", linksImpl)] }],
    { stageId: "implement", state: "running", input: null, activatedBy: null }),
  pipeline("p-limits", "Show the account limit reset time on the card", "t-limits", "needs_decision",
    [stage("build", "builder", "review", { onFail: { to: "diagnose", maxRounds: 1 } }), stage("review", "reviewer", null), stage("diagnose", "architect", null)],
    [
      { stageId: "build", attempts: [attempt(1, "failed", limitsBuild)] },
      { stageId: "diagnose", attempts: [attempt(1, "needs_decision", limitsDiag, { activatedBy: { stageId: "build", attempt: 1, edge: "fail" } })] },
    ],
    { stageId: "diagnose", state: "running", input: null, activatedBy: null }),
  pipeline("p-attach", "Finish responsive native attachment delivery", "t-attach", "running",
    [stage("build", "builder", "verify"), stage("verify", "verifier", null)],
    [{ stageId: "build", attempts: [attempt(1, "passed", attachBuild)] }, { stageId: "verify", attempts: [attempt(1, "running", attachVerify)] }],
    { stageId: "verify", state: "running", input: null, activatedBy: null }),
  pipeline("p-compact", "Compact board stages and separate history from live work", "t-compact", "completed",
    [stage("build", "builder", "review"), stage("review", "reviewer", "verify"), stage("verify", "verifier", null)],
    [
      { stageId: "build", attempts: [attempt(1, "passed", compactBuild)] },
      { stageId: "review", attempts: [attempt(1, "passed", compactRev, { ...flowOf("flow-compact-review"), reviewFlowSync: { generation: "g3", roundCount: 1, implementerHeadSha: null, reviewerHeadSha: null, verdict: null, relayState: "approved", terminalState: null } })] },
      { stageId: "verify", attempts: [attempt(1, "passed", compactVer)] },
    ],
    null),
  ...(roundsBuild && roundsReview ? [pipeline("p-rounds", "Rework the retry banner until review passes", "t-rounds", "running",
    [stage("build", "builder", "review"), stage("review", "reviewer", null)],
    [
      { stageId: "build", attempts: [attempt(1, "passed", roundsBuild, { startedAt: iso(4 * 60 * MIN) })] },
      { stageId: "review", attempts: [attempt(1, "reviewing", roundsReview, { flowId: "flow-rounds-review", startedAt: iso(3 * 60 * MIN) })] },
    ],
    { stageId: "review", state: "reviewing", input: null, activatedBy: null })] : []),
];

if (STAGES) {
  for (const record of pipelines) {
    for (const entry of record.stages) {
      const prompt = PROMPTS[`${record.id}:${entry.id}`];
      if (prompt) entry.prompt = prompt;
    }
  }
  /* As the prototype's fixture has them: each attempt names the edge that
     started it, and Review ran once per Implement attempt. */
  type Run = { stageId: string; attempts: Array<Record<string, unknown>> };
  const runsOf = (id: string) => (pipelines.find((entry) => entry.id === id)!.runs as unknown as Run[]);
  const upload = runsOf("p-upload");
  const chain = ["plan", "build-api", "review-api", "build-ui"];
  for (const run of upload) {
    const previous = chain[chain.indexOf(run.stageId) - 1];
    if (previous) run.attempts[0]!.activatedBy = { stageId: previous, attempt: 1, edge: "pass" };
  }
  const search = runsOf("p-search");
  const review = search.find((run) => run.stageId === "review")!;
  review.attempts = [
    attempt(1, "passed", searchRevFirst, { startedAt: iso(120 * MIN), activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } }),
    { ...review.attempts[0]!, n: 2, activatedBy: { stageId: "implement", attempt: 2, edge: "pass" } },
  ];
  const verify = search.find((run) => run.stageId === "verify")!;
  verify.attempts[0]!.activatedBy = { stageId: "review", attempt: 1, edge: "pass" };
  verify.attempts[1]!.activatedBy = { stageId: "review", attempt: 2, edge: "pass" };
}
if (ACCOUNTS) {
  /* K6: Docs names the account its first turn runs on; Merge leaves it to the project. The running Verify launched on account A. */
  const uploadDocs = pipelines.find((entry) => entry.id === "p-upload")!.stages.find((entry) => entry.id === "docs")!;
  uploadDocs.account = "account-c";
  const searchVerify = (pipelines.find((entry) => entry.id === "p-search")!.runs as unknown as Array<{ stageId: string; attempts: Array<Record<string, unknown>> }>).find((run) => run.stageId === "verify")!;
  searchVerify.attempts[1]!.accountId = "default";
}

/* K6: the accounts of each engine, as `GET /api/accounts` answers them, and the project's accounts (#1279). */
const resetIn = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
const tierLimits = {
  session: { usedPercent: 12, resetsAt: resetIn(120), windowMinutes: 300 },
  weekly: { usedPercent: 30, resetsAt: resetIn(6000), windowMinutes: 10080 },
  tiers: CODENAME_TIERS ? [
    // The bucket key is a codename; the label is the provider's own, and the
    // label is what the operator must read (#1839).
    { tier: "nimbus_quill", label: "Fable", usedPercent: 88, resetsAt: resetIn(6000), windowMinutes: 10080 },
    // No label came with this one, so its bucket key is spelled out as words.
    { tier: "cedar_ember", usedPercent: 63, resetsAt: resetIn(6000), windowMinutes: 10080 },
  ] : [
    { tier: "fable", usedPercent: 88, resetsAt: resetIn(6000), windowMinutes: 10080 },
    { tier: "opus", usedPercent: 63, resetsAt: resetIn(6000), windowMinutes: 10080 },
  ],
  plan: "max", capturedAt: now,
};
const accountRow = (id: string, label: string, plan: string, usedPercent: number, resetsInMinutes: number) => ({
  id, label, kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
  auth: { state: "authenticated", plan },
  limits: { state: "fresh", session: { usedPercent, resetsAt: resetIn(resetsInMinutes), windowMinutes: 300 }, weekly: null },
});
const accountsBody = {
  claude: {
    active: "default",
    accounts: [accountRow("default", "Account A", "Max", 72, 140), accountRow("account-c", "Account C", "Max", 18, 170), accountRow("account-g", "Account G", "Pro", 41, 125), accountRow("account-e", "Account E", "Pro", 100, 80)],
    mutationLocked: false, migration: null, autoBalance: null,
  },
  codex: {
    active: "default",
    accounts: [accountRow("default", "Account B", "Pro", 35, 200), accountRow("account-d", "Account D", "Plus", 12, 230)],
    mutationLocked: false, migration: null, autoBalance: null,
  },
};
/* Claude work in this project may use accounts A, C and E; Codex is unbound. */
const CLAUDE_ALLOWED = ["default", "account-c", "account-e"];
const bindingsBody = {
  project: PROJECT, projectName: PROJECT, bindings: [],
  engines: {
    claude: { engine: "claude", restricted: true, allowed: CLAUDE_ALLOWED.map((accountId) => ({ accountId, label: accountId })), carrying: [], outsidePool: [] },
    codex: { engine: "codex", restricted: false, allowed: accountsBody.codex.accounts.map((row) => ({ accountId: row.id, label: row.label })), carrying: [], outsidePool: [] },
  },
};

/* Review flows as the store keeps them: one per bound review stage, with its rounds. */
const reviewRole = { engine: "codex", model: "gpt-5.6", effort: "high" };
function reviewFlow(id: string, implementer: FileEntry, reviewer: FileEntry, verdicts: Array<"APPROVE" | "REQUEST_CHANGES">, startedAgo: number) {
  return {
    id, template: "implement-review-loop", project: PROJECT, cwd: "/repo", implementerPath: implementer.path, implementerConversationId: implementer.conversationId,
    roles: { implementer: { engine: "claude", model: "opus", effort: "high" }, reviewer: reviewRole }, baseRef: "0000000", baseMode: "merge-base", mode: "auto",
    reviewerMode: "headless", roundLimit: 5, state: "approved", stateDetail: null, createdAt: iso(startedAgo + 10 * MIN), closedAt: null,
    rounds: verdicts.map((verdict, index) => ({
      n: index + 1, reviewerPath: index === verdicts.length - 1 ? reviewer.path : null, reviewerConversationId: index === verdicts.length - 1 ? reviewer.conversationId : null,
      findingsPath: null, triggeredBy: "marker", readyNote: null, verdict, findingsCount: verdict === "APPROVE" ? 0 : 2, startedAt: iso(startedAgo - index * 20 * MIN),
    })),
  };
}
const flows = PIPELINES ? [
  reviewFlow("flow-search-review", searchImpl2, searchRev, ["APPROVE"], 45 * MIN),
  reviewFlow("flow-upload-review-api", uploadApi, uploadRevApi, ["REQUEST_CHANGES", "APPROVE"], 5 * 60 * MIN),
  reviewFlow("flow-compact-review", compactBuild, compactRev, ["APPROVE"], 2 * 24 * 60 * MIN),
  reviewFlow("flow-rounds-review", roundsBuild!, roundsReview!, ["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES", "APPROVE"], 3 * 60 * MIN),
] : LOOSE ? [reviewFlow("flow-export-review", exportImpl, exportReview!, ["APPROVE"], 30 * MIN)] : [];

let revision = 1;
function task(id: string, status: TaskStatus, title: string, description: string, updatedAgo: number, members: FileEntry[] = [], over: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project: PROJECT, text: description ? `${title}\n${description}` : title, status, placement: "unplaced",
    assignments: members.map((member) => ({ path: member.path, conversationId: member.conversationId, panePid: null, state: "delivered", error: null, at: iso(updatedAgo) })),
    createdAt: iso(updatedAgo + 60 * MIN), updatedAt: iso(updatedAgo), revision: REV(revision++), ...over,
  } as BoardTask;
}

const tasks: BoardTask[] = [
  /* The one task carrying agent-facing details (#1834): the long context an
     agent needs, which the card folds behind its Details row instead of
     printing where the human description belongs. */
  task("t-search", "assigned", "Restore search results after the index rebuild", "Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.", 4 * MIN, [], {
    details: [
      "Stage: implement. Worktree /repo/atlas, branch lane/search-index-swap.",
      "Read the swap path in src/search/indexSwap.ts before changing anything: the old index must answer every read until the new one reports ready, and the swap is one atomic rename.",
      "Files another lane holds, do not edit: src/search/query.ts, src/search/ranking.ts, src/search/analyzers/*.",
      "Rules: no new dependency; no schema change; the rebuild stays resumable; every refusal names its field.",
      "Gates: the typecheck, the touched tests by path, the build.",
      "Known state: rebuild-12 left a half-written segment under var/index/next; the reader already skips it, the writer does not.",
      "Reads that reproduce it: GET /search?q=atlas during a rebuild, then again after the swap.",
      "Prior attempt: lane/search-index-lock held the whole index for the rebuild and timed out the reads; do not take that path again.",
      "Answer the operator with what the reads returned, never with what the code intends.",
      "Report through the stage tool; the verdict is the only completion channel.",
    ].join("\n"),
  } as Partial<BoardTask>),
  task("t-upload", "assigned", "Redesign attachment upload for large files", "Resumable uploads for files over 100 MB: chunked API, a progress UI that survives a reload, and docs.", 2 * MIN),
  task("t-export", "assigned", "Simplify the export settings sheet", "Fold the eleven toggles into three sensible presets and one advanced disclosure.", 9 * MIN, [exportImpl, exportExplore]),
  task("t-links", "assigned", "Repair old links in the release notes", "", 17 * MIN),
  task("t-merge-a", "assigned", "Merge the approved queue adapter release · merge", "", 26 * 60 * MIN),
  task("t-verify-a", "assigned", "Verify delivery recovery across transcript boundaries · verify", "", 30 * 60 * MIN),
  task("t-disk", "assigned", "Disk space: find what Docker, worktrees and temp storage hold", "", 41 * 60 * MIN),
  task("t-longtitle", "inbox", "You are the reviewer in an implement-review loop. Working directory is the lane worktree. Read the diff against the merge base, run the touched tests by path, and answer with one verdict block; do not change product source in this stage.", "", 3 * 60 * MIN),
  task("t-pending", "inbox", "", "", 6 * MIN, [pendingWorker], { origin: { kind: "launch", key: "launch-pending", refinement: "pending" } } as Partial<BoardTask>),
  task("t-onboarding", "inbox", "Write the first-run walkthrough", "Three screens, one action each. No tour bubbles.", 2 * 24 * 60 * MIN),
  /* One earlier conversation of this task is outside the scheme window. */
  task("t-auth", "blocked", "Passkey sign-in for the shared board", "Waiting on the domain decision before the relying-party id can be fixed.", 20 * 60 * MIN, [authImpl, conversation("auth-earlier", "Implementer: first passkey attempt")]),
  task("t-limits", "blocked", "Show the account limit reset time on the card", "", 3 * 24 * 60 * MIN),
  task("t-interrupt", "done", "Universal interrupt and stop for every engine", "", 8 * 60 * MIN),
  task("t-attach", "done", "Finish responsive native attachment delivery", "", 12 * 60 * MIN),
  task("t-compact", "done", "Compact board stages and separate history from live work", "", 2 * 24 * 60 * MIN),
  task("t-voice", "done", "Keep the orchestrator role when voice is enabled", "", 3 * 24 * 60 * MIN),
  task("t-queue", "done", "Preserve native queue recovery through journal compaction", "", 4 * 24 * 60 * MIN),
  task("t-old", "done", "An empty task someone took off the board", "", 9 * 24 * 60 * MIN, [], { board: "hidden" }),
  ...(PIPELINES ? [task("t-rounds", "assigned", "Rework the retry banner until review passes", "", 12 * MIN)] : []),
  ...(MANY ? [task("t-many", "assigned", "Kanban: say what each pipeline of a task does", "Five pipelines on one card: two running, three finished.", 5 * MIN)] : []),
  ...(MARKS ? [task("t-marks", "assigned", "Say who runs each stage, and how often an edge fired", "Two pipelines: one fail edge fired twice of three, one with its budget spent.", 4 * MIN)] : []),
  ...(ARCS ? [task("t-arcs", "assigned", "Draw a fail edge as a return arc under the row", "An edge at rest, one fired once, a spent budget in flight, a lane parked on a spent budget, and two edges into one stage.", 3 * MIN)] : []),
];
if (OVERVIEW_SCOPE) {
  tasks.push(
    task("t-ledger", "assigned", "Reconcile the ledger export against the bank file", "Two of the quarter's statements disagree by one day.", 3 * MIN, [ledgerBuild!], { project: LEDGER }),
    task("t-ledger-quiet", "assigned", "Archive last quarter's statements", "", 4 * 60 * MIN, [ledgerQuiet!], { project: LEDGER }),
    task("t-mesh", "blocked", "Unblock the mesh id migration", "The old ids must survive the cut-over.", 11 * MIN, [meshAsk!], { project: MESH }),
    task("t-mesh-quiet", "done", "Write the migration notes", "", 6 * 60 * MIN, [meshQuiet!], { project: MESH }),
  );
}
if (EDITING) {
  const at = (id: string) => tasks.findIndex((entry) => entry.id === id);
  const hide = (id: string, by: "operator" | "agent", secondsAgo: number) => {
    const row = tasks[at(id)]!;
    tasks[at(id)] = { ...row, groupHidden: { at: iso(secondsAgo), by, admitted: admissionSnapshot(row.assignments) } } as BoardTask;
  };
  const merge = tasks[at("t-merge-a")]!;
  tasks[at("t-merge-a")] = { ...merge, assignments: [{ path: mergeImpl!.path, conversationId: mergeImpl!.conversationId, panePid: null, state: "delivered", error: null, at: iso(26 * 60 * MIN) }] } as BoardTask;
  hide("t-merge-a", "operator", 3 * 60 * MIN);
  hide("t-verify-a", "agent", 5 * 60 * MIN);
  hide("t-compact", "operator", 20 * 60 * MIN);
  /* Hidden by an agent before this conversation took the seat: the seat keeps it on the board. */
  tasks.push(task("t-seat", "assigned", "Coordinate the atlas release", "What the orchestrator is steering this week.", 30 * MIN, [orchestrator]));
  hide("t-seat", "agent", 10 * 60 * MIN);
}

/* Short transcripts in the Claude line format, so every reader has a feed. */
const line = (secondsAgo: number, body: Record<string, unknown>) => JSON.stringify({ timestamp: iso(secondsAgo), ...body });
const said = (secondsAgo: number, text: string) => line(secondsAgo, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const asked = (secondsAgo: number, text: string) => line(secondsAgo, { type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
const tool = (secondsAgo: number, id: string, name: string, input: Record<string, unknown>) => [
  line(secondsAgo, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
  line(secondsAgo - 2, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
];
function transcriptOf(pathname: string): string {
  const file = files.find((entry) => entry.path === pathname);
  if (!file || file === pendingWorker) return "";
  /* The running verifier has a long transcript: its reader scrolls. */
  if (file === searchVer2) {
    const long = [asked(90 * MIN, `${file.title} — pick it up from the task text.`)];
    for (let step = 0; step < 24; step += 1) long.push(said((88 - step * 3) * MIN, `Step ${step + 1}: re-ran the rebuild against live traffic and checked the alias swap window.`));
    return `${long.join("\n")}\n`;
  }
  const lines = file === orchestrator
    ? [
      asked(8 * MIN, "Keep the search fix moving. When the passkey domain is settled, set up a pipeline for the fallback."),
      said(7 * MIN, "Search: the verifier failed once (results were empty for 40 s after the swap). The fail edge sent it back to Implement; attempt 2 passed review and Verify is running again."),
      ...tool(6 * MIN, "toolu_seat_1", "mcp__viewer__list_pipelines", { project: PROJECT }),
      said(2 * MIN, "The release-notes implementer is waiting on you: two anchors match and it needs to know which one wins."),
    ]
    : [
      asked(40 * MIN, `${file.title} — pick it up from the task text.`),
      said(38 * MIN, "Starting on it."),
      ...tool(36 * MIN, `toolu_${file.name}_1`, "Read", { file_path: "src/export/presets.ts" }),
      ...tool(34 * MIN, `toolu_${file.name}_2`, "Bash", { command: "rg --files src/components" }),
      said(30 * MIN, "Checking the fallback path next; nothing to decide yet."),
    ];
  return `${lines.join("\n")}\n`;
}

const params = new URLSearchParams(location.search);
let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: {
    manual: [], hidden: oldSpike ? [oldSpike.path] : [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [],
    viewMode: "scheme", desktopBoard: params.get("face") === "scheme" ? null : "kanban", taskPanelOpen: false,
  },
} as unknown as BoardProjectStateV1;

const evidence = {
  taskPatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  presence: [] as Array<{ mode: string; visiblePaths: string[]; focusedPath: string | null }>,
  assignments: [] as Array<{ method: string; id: string; body: Record<string, unknown> }>,
  /* The focus handoff this page's Viewer runs, for driving an attention
     arrival without a server behind the offer. */
  /* `startArrivalPulse` is here for the same reason: a driver that set the
     attribute itself would photograph the stylesheet and prove nothing about
     the code that decides WHAT to mark and how (#1836 item 4). */
  focus: { bus: focusHandoffBus, runFocusTransaction, startArrivalPulse, cancelArrivalPulse },
  /* Transcript reads for this path fail, as a broken route would. */
  failLogsFor: null as string | null,
  /* A write another client made to a task, arriving on the next task read:
     the card re-ranks within its column. */
  touchTask(id: string) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index >= 0) tasks[index] = { ...tasks[index]!, updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  /* A status another client wrote, arriving on the next task read. */
  setTaskStatus(id: string, status: TaskStatus) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index >= 0) tasks[index] = { ...tasks[index]!, status, updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  boardMutations: [] as BoardMutationV1[],
  refuseNextTaskPatch: false,
  taskAnswerDelayMs: 400,
  /* When each task write reached the fixture and when it was answered. */
  taskWrites: [] as Array<{ id: string; startedAt: number; answeredAt: number }>,
  /* Tasks created from the board's «+ Task» (K9a), as the route received them. */
  taskCreates: [] as Array<Record<string, unknown>>,
  /* An agent renames a task: the new title arrives on the next task read. */
  agentWritesTitle(id: string, title: string) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const row = tasks[index]!;
    const newline = row.text.search(/\r?\n/);
    tasks[index] = { ...row, text: newline < 0 ? title : title + row.text.slice(newline), updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  /* An agent rewrites a task's description where this page cannot see it
     yet: the board's next guarded write meets the newer revision. */
  agentWritesDescriptionQuietly(id: string, description: string) {
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const row = tasks[index]!;
    const title = row.text.split(/\r?\n/, 1)[0] ?? "";
    tasks[index] = { ...row, text: `${title}\n${description}`, updatedAt: new Date().toISOString(), revision: REV(revision++) } as BoardTask;
  },
  /* How long each catalog read takes to answer. The answer is what the store
     held when the read began, as a slow poll would carry. */
  filesDelayMs: 0,
  /* Reads of the orchestrator seat route. */
  seatReads: 0,
  /* A conversation starts waiting on the operator, arriving on the next read. */
  askDecision(pathname: string) {
    const index = files.findIndex((entry) => entry.path === pathname);
    if (index < 0) return;
    files[index] = { ...files[index]!, mtime: Math.floor(Date.now() / 1000), waitingInput: { since: Math.floor(Date.now() / 1000) } } as FileEntry;
    window.dispatchEvent(new Event("llv:tasks-changed"));
  },
  /* A new attempt of a pipeline stage, as the engine records it, arriving on
     the next catalog read. */
  addStageAttempt(pipelineId: string, stageId: string, over: Record<string, unknown>) {
    const record = pipelines.find((entry) => entry.id === pipelineId) as unknown as { runs: Array<{ stageId: string; attempts: Array<Record<string, unknown>> }>; cursor: unknown } | undefined;
    if (!record) return;
    let run = record.runs.find((entry) => entry.stageId === stageId);
    if (!run) record.runs.push(run = { stageId, attempts: [] });
    run.attempts.push(attempt(run.attempts.length + 1, "running", null, over));
    /* A lineage-adopted attempt is evidence; it never moves the cursor. */
    if (!over.historical) record.cursor = { stageId, state: "running", input: null, activatedBy: over.activatedBy ?? null };
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* The stored row, as the fixture's server holds it. */
  storedTask(id: string) {
    return tasks.find((entry) => entry.id === id) ?? null;
  },
  /* K5b: the pipeline route's reads and writes, in order. */
  pipelineReads: [] as string[],
  pipelinePatches: [] as Array<{ id: string; body: Record<string, unknown> }>,
  pipelineAnswerDelayMs: 300,
  /* The next pipeline write is refused with these words. */
  refuseNextPipelinePatch: null as { status: number; error: string } | null,
  /* The next pipeline write finds this stage started: the engine's race. */
  startStageOnNextPatch: null as { pipelineId: string; stageId: string } | null,
  /* The next pipeline write is carried out and its answer is lost on the way back. */
  loseNextPipelineAnswer: false,
  /* Another client saves this stage's prompt after the board's read and before its write lands. */
  changeStageBeforeNextPatch: null as { pipelineId: string; stageId: string; prompt: string } | null,
  /* Another client acts first: the pipeline now waits on this stage. */
  moveCursor(pipelineId: string, stageId: string) {
    const index = pipelines.findIndex((entry) => entry.id === pipelineId);
    if (index < 0) return;
    pipelines[index] = { ...pipelines[index]!, cursor: { stageId, state: "running", input: null, activatedBy: null } } as Pipeline;
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* Another client saves a stage's prompt; this page learns it on its next read. */
  writeStagePromptQuietly(pipelineId: string, stageId: string, prompt: string) {
    const record = pipelines.find((entry) => entry.id === pipelineId);
    const target = record?.stages.find((entry) => entry.id === stageId);
    if (target) target.prompt = prompt;
  },
  storedPipeline(id: string) {
    return pipelines.find((entry) => entry.id === id) ?? null;
  },
  /* K6: conversation account switches the board sent, in order. */
  accountRequests: [] as Array<Record<string, unknown>>,
  /* Reconfigures the runtime pill sent (#1846). */
  pillRequests: [] as Array<Record<string, unknown>>,
  accountAnswerDelayMs: 200,
  /* The next switch is refused with these words. */
  refuseNextAccountRequest: null as { status: number; error: string } | null,
  /* The next switch is queued and its answer is lost on the way back. */
  loseNextAccountAnswer: false,
  /* The project's accounts cannot be read. */
  bindingsUnreadable: false,
  /* K6b: cancels and withdrawals sent to the conversation migration route, in order. */
  migrationRequests: [] as Array<{ conversationId: string; body: Record<string, unknown> }>,
  /* The next cancel or withdrawal is refused with these words and code. */
  refuseNextMigrationRequest: null as { status: number; error: string; code: string } | null,
  /* The conversation's migration record, as the files route projects it. */
  setMigration(pathname: string, migration: Record<string, unknown> | null) {
    const index = files.findIndex((entry) => entry.path === pathname || entry.conversationId === pathname);
    if (index < 0) return;
    const next = { ...files[index]! };
    if (migration) next.migration = migration as unknown as FileEntry["migration"];
    else delete next.migration;
    files[index] = next;
    window.dispatchEvent(new Event("llv:files-changed"));
  },
  /* A committed switch: the transcript continues under the target account's home, the record clears. */
  commitAccountSwitch(conversationId: string, accountId: string) {
    const index = files.findIndex((entry) => entry.conversationId === conversationId);
    if (index < 0) return;
    const current = files[index]! as FileEntry & { migration?: unknown };
    const path = `/repo/accounts/${current.engine}/${accountId}/${current.name}`;
    for (const record of pipelines) {
      for (const run of record.runs) for (const entry of run.attempts) if (entry.conversationId === conversationId) entry.agentPath = path;
    }
    const next = { ...current, path } as FileEntry & { migration?: unknown };
    delete next.migration;
    files[index] = next as FileEntry;
    window.dispatchEvent(new Event("llv:files-changed"));
    window.dispatchEvent(new Event("llv:pipelines-changed"));
  },
  /* #1836: a lane the server has admitted that the corpus scan does not carry
     yet. `/api/attention` hands it out as the pushed rows; `/api/files` never
     does, so a board that draws it drew it from the push. */
  admitted: null as { pipeline: Pipeline; task: BoardTask } | null,
  /* Every `/api/attention` call, as the page made it. */
  attentionCalls: [] as Array<{ url: string; method: string }>,
  admitLane(title: string) {
    evidence.admitted = {
      pipeline: pipeline("p-admitted", title, "t-admitted", "provisioning",
        [stage("build", "builder", "review"), stage("review", "reviewer", null)], [],
        { stageId: "build", state: "pending", input: null, activatedBy: null }, { createdAt: new Date().toISOString() }),
      task: task("t-admitted", "assigned", title, "", 0),
    };
  },
};
Object.assign(window, { evidence });

/* Streams stay silent, except the log stream, which reports it cannot connect
   so the feeds read their transcripts through the polled route below. */
class QuietEventSource {
  onerror: ((event: Event) => void) | null = null;
  constructor(url: string | URL) {
    if (String(url).startsWith("/api/logs/stream")) setTimeout(() => this.onerror?.(new Event("error")), 0);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.assign(window, { EventSource: QuietEventSource });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* The engine's stage digest (`stageDigest`) is a SHA-256 the server computes;
   this page has no server, so its route answers an opaque stand-in over the
   same canonical fields. The board only ever hands a digest back. */
function fixtureStageDigest(stage: Pipeline["stages"][number]): string {
  const canonical = JSON.stringify({
    "prompt": stage.prompt,
    account: typeof stage.account === "string" && stage.account.trim() ? stage.account.trim() : null,
    role: stage.role ? { roleId: stage.role.roleId, params: stage.role.params ?? null } : null,
    runtime: { engine: stage.effectiveRole.engine, model: stage.effectiveRole.model ?? null, effort: stage.effectiveRole.effort ?? null, access: stage.effectiveRole.access ?? null },
  });
  let hex = "";
  for (let seed = 0; seed < 8; seed += 1) {
    let hash = 0x811c9dc5 ^ seed;
    for (let index = 0; index < canonical.length; index += 1) hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193);
    hex += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/files") {
    /* #1820's first run: an installation with nothing in it at all. */
    /* Nothing is working in the quiet installation: every conversation has
       an idle process and a turn that closed, nothing waits on the operator,
       and no pipeline is in flight. The projects and their tasks are the
       same ones. */
    const shown = OVERVIEW_QUIET
      ? files.map((file) => ({
        ...file,
        activity: "idle",
        proc: null,
        pid: null,
        waitingInput: null,
        pendingQuestion: null,
        authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: iso(4 * 60 * MIN) },
        lastTurn: { startedAt: (now - 5 * 60 * MIN) * 1_000, endedAt: (now - 4 * 60 * MIN) * 1_000 },
      } as unknown as FileEntry))
      : files;
    const scoped = OVERVIEW_EMPTY
      ? { files: [], projectCatalog: [], flows: [], pipelines: [], tasks: [] }
      : {
        files: shown,
        projectCatalog: [...new Set(shown.map((file) => file.project))].map((project) => {
          const own = shown.filter((file) => file.project === project);
          return { project, conversations: own.length, smt: Math.max(...own.map((file) => file.mtime)) };
        }),
        flows: OVERVIEW_QUIET ? [] : flows,
        pipelines: OVERVIEW_QUIET ? [] : pipelines,
        tasks,
      };
    const body = JSON.stringify({ ...scoped, workflows: [], systemHealth: { tmux: { status: "healthy" } } });
    if (evidence.filesDelayMs) await new Promise((resolve) => setTimeout(resolve, evidence.filesDelayMs));
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/api/attention") {
    evidence.attentionCalls.push({ url: url.pathname + url.search, method });
    if (method !== "GET") return json({ error: "unsupported in the evidence fixture" }, 400);
    const echoed = (url.searchParams.get("echoes") ?? "").split(",").filter(Boolean);
    const admitted = evidence.admitted;
    const withdrawn = echoed.filter((id) => id !== admitted?.pipeline.id).map((id) => ({ id, reason: "never-materialized" }));
    const records = admitted || withdrawn.length
      ? { pipelines: admitted ? [admitted.pipeline] : [], tasks: admitted ? [admitted.task] : [], withdrawn }
      : null;
    if (!url.searchParams.get("deviceId")) return json({ ok: true, records });
    return json({ ok: true, rootId: "root-fixture", offer: null, live: [], expired: [], records });
  }
  if (url.pathname === "/api/runtime/snapshot" && STRUCTURED) return json(structuredSnapshot());
  if (url.pathname === "/api/runtime/snapshot") return json({ code: RUNTIME_PLANE_ABSENT }, 503);
  if (STRUCTURED && url.pathname === "/api/tmux" && method === "POST") {
    evidence.pillRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json({ ok: true, structured: true });
  }
  if (url.pathname === "/api/board") {
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { mutations?: BoardMutationV1[] };
      evidence.boardMutations.push(...(body.mutations ?? []));
      const reduced = applyBoardMutations(board, body.mutations ?? []);
      board = { ...reduced, schemaVersion: 1, revision: board.revision + 1, pathAliases: reduced.pathAliases ?? {} };
      return json({ ok: true, applied: true, board });
    }
    return json({ ok: true, board });
  }
  if (url.pathname === "/api/view/presence" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { mode: string; visiblePaths: string[]; focusedPath?: string | null };
    evidence.presence.push({ mode: body.mode, visiblePaths: body.visiblePaths, focusedPath: body.focusedPath ?? null });
    return json({ ok: true });
  }
  if (url.pathname === "/api/tasks" && method === "GET") return json({ tasks: OVERVIEW_EMPTY ? [] : tasks });
  if (url.pathname === "/api/tasks" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    evidence.taskCreates.push(body);
    const at = new Date().toISOString();
    const created = { id: `created-${evidence.taskCreates.length}`, project: PROJECT, text: String(body.text), status: "inbox", placement: body.placement, assignments: [], createdAt: at, updatedAt: at, revision: REV(revision++) } as BoardTask;
    tasks.push(created);
    return json({ ok: true, task: created });
  }
  /* A draft pane's directory suggestions (K9a): the fixture's one checkout. */
  if (url.pathname === "/api/spawn" && method === "GET") return json({ dirs: ["/repo"], cwd: null });
  if (url.pathname.startsWith("/api/tasks/") && method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    evidence.taskPatches.push({ id, body });
    const write = { id, startedAt: performance.now(), answeredAt: 0 };
    evidence.taskWrites.push(write);
    await new Promise((resolve) => setTimeout(resolve, evidence.taskAnswerDelayMs));
    write.answeredAt = performance.now();
    if (evidence.refuseNextTaskPatch) {
      evidence.refuseNextTaskPatch = false;
      return json({ error: "refused by the evidence fixture" }, 500);
    }
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "task not found" }, 404);
    const current = tasks[index] as BoardTask & { revision: string };
    if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) return json({ error: "expectedRevision is stale", code: "TASK_REVISION_MISMATCH", field: "expectedRevision" }, 409);
    /* The route's rules for the fields the board writes (#1695 K4a). */
    const next = { ...current } as BoardTask & Record<string, unknown>;
    if (body.status) next.status = body.status as TaskStatus;
    if (body.board) next.board = body.board as BoardTask["board"];
    if (typeof body.text === "string") {
      next.text = body.text;
      if (current.origin?.refinement === "pending") next.origin = { ...current.origin, refinement: "titled" };
    }
    if (body.color !== undefined) {
      if (body.color === "none") delete next.color;
      else next.color = body.color as BoardTask["color"];
    }
    /* Agent-facing details (#1834), on the route's own terms: a string sets it,
       null or an empty string clears the field rather than leaving it empty. */
    if (body.details !== undefined) {
      const details = typeof body.details === "string" ? body.details.trim() : "";
      if (details) next.details = details;
      else delete next.details;
    }
    if (body.hide === true) {
      if (current.assignments.some((row) => row.conversationId === orchestrator.conversationId)) {
        return json({ error: "this task holds the project's orchestrator seat conversation, which stays on the board; it cannot be hidden", code: "TASK_HIDE_PROTECTED", field: "hide" }, 409);
      }
      next.groupHidden = { at: new Date().toISOString(), by: "operator", admitted: admissionSnapshot(current.assignments) };
    } else if (body.hide === false) {
      delete next.groupHidden;
    }
    const presentationOnly = Object.keys(body).every((key) => key === "color" || key === "hide" || key === "expectedProject" || key === "expectedRevision");
    next.updatedAt = presentationOnly ? current.updatedAt : new Date().toISOString();
    next.revision = REV(revision++);
    tasks[index] = next;
    return json({ ok: true, task: next });
  }
  if (url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/assignment")) {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.assignments.push({ method, id, body });
    const index = tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "task not found" }, 404);
    const current = tasks[index]!;
    if (method === "POST") {
      const next = { ...current, assignments: [...current.assignments, { path: String(body.path), panePid: null, state: "handoff", error: null, at: new Date().toISOString() }], revision: REV(revision++) } as BoardTask;
      tasks[index] = next;
      return json({ ok: true, task: next });
    }
    const matches = (assignment: BoardTask["assignments"][number]) => (body.conversationId ? assignment.conversationId === body.conversationId : assignment.path === body.path);
    /* A conversation whose only task this is has nowhere to go: the route's refusal. */
    if (current.assignments.filter(matches).length && !tasks.some((other) => other.id !== id && other.assignments.some(matches))) {
      return json({ error: "this task is the conversation's own membership; link the conversation to another task first or delete the task" }, 409);
    }
    const next = { ...current, assignments: current.assignments.filter((assignment) => !matches(assignment)), revision: REV(revision++) } as BoardTask;
    tasks[index] = next;
    return json({ ok: true, task: next });
  }
  if (url.pathname.startsWith("/api/pipelines/")) {
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const index = pipelines.findIndex((entry) => entry.id === id);
    if (index < 0) return json({ error: "pipeline not found" }, 404);
    if (method === "GET") {
      evidence.pipelineReads.push(id);
      const read = pipelines[index]!;
      return json({ ok: true, pipeline: read, stageDigests: Object.fromEntries(read.stages.map((stage) => [stage.id, fixtureStageDigest(stage)])) });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      evidence.pipelinePatches.push({ id, body });
      await new Promise((resolve) => setTimeout(resolve, evidence.pipelineAnswerDelayMs));
      const record = structuredClone(pipelines[index]!) as Pipeline;
      const runs = record.runs as unknown as Array<{ stageId: string; attempts: unknown[] }>;
      const race = evidence.startStageOnNextPatch;
      if (race && race.pipelineId === id) {
        evidence.startStageOnNextPatch = null;
        let run = runs.find((entry) => entry.stageId === race.stageId);
        if (!run) runs.push(run = { stageId: race.stageId, attempts: [] });
        run.attempts.push(attempt(run.attempts.length + 1, "running", linksReview, { startedAt: new Date().toISOString(), activatedBy: { stageId: "implement", attempt: 1, edge: "pass" } }));
        record.cursor = { stageId: race.stageId, state: "running", input: null, activatedBy: null } as Pipeline["cursor"];
        record.state = "running";
        pipelines[index] = record;
      }
      const between = evidence.changeStageBeforeNextPatch;
      if (between && between.pipelineId === id) {
        evidence.changeStageBeforeNextPatch = null;
        const target = record.stages.find((entry) => entry.id === between.stageId);
        if (target) target.prompt = between.prompt;
        pipelines[index] = structuredClone(record);
      }
      if (evidence.refuseNextPipelinePatch) {
        const refusal = evidence.refuseNextPipelinePatch;
        evidence.refuseNextPipelinePatch = null;
        return json({ error: refusal.error }, refusal.status);
      }
      /* The engine's guards (#1695 C7, retry/skip), checked before anything changes. */
      const stageChanged = (field: string, error: string) => json({ error, code: "STAGE_CHANGED", field }, 409);
      if ((body.action === "retry-stage" || body.action === "skip-stage") && body.expectedStageId !== undefined) {
        const waiting = record.state === "needs_decision" ? record.cursor?.stageId ?? null : null;
        if (waiting !== body.expectedStageId) return stageChanged("expectedStageId", `the pipeline waits on ${waiting ?? "no stage"}, not ${String(body.expectedStageId)}`);
        const latest = record.runs.find((run) => run.stageId === waiting)?.attempts.findLast((entry) => !entry.historical)?.n ?? 0;
        if (body.expectedAttempt !== undefined && latest !== body.expectedAttempt) return stageChanged("expectedAttempt", `${waiting} waits on ${latest ? `attempt ${latest}` : "no attempt of its own"}`);
      }
      /* The engine's preconditions for what the board sends (`patchPipeline`). */
      const ended = record.state === "completed" || record.state === "closed";
      if (body.action === "override-stage") {
        if (ended) return json({ error: "pipeline is closed or completed" }, 409);
        const target = record.stages.find((entry) => entry.id === body.stageId);
        if (!target) return json({ error: "stage not found" }, 404);
        if ((record.runs.find((entry) => entry.stageId === target.id)?.attempts.length ?? 0) > 0) return json({ error: "stage has already started" }, 409);
        if (body.expectedStageDigest !== undefined && fixtureStageDigest(target) !== body.expectedStageDigest) return stageChanged("expectedStageDigest", "the stage changed since it was read; read it again before overriding it");
        if (typeof body.prompt === "string") target.prompt = body.prompt;
        /* #1279: a stage may name only an account the project allows; null clears the pin. */
        if (body.account !== undefined) {
          const requested = typeof body.account === "string" ? body.account.trim() : "";
          if (requested && target.effectiveRole.engine === "claude" && !CLAUDE_ALLOWED.includes(requested)) {
            return json({ error: `claude account ${requested} is not allowed on project ${PROJECT} (allowed: ${CLAUDE_ALLOWED.join(", ")})` }, 409);
          }
          if (requested) target.account = requested;
          else delete target.account;
        }
      } else if (body.action === "pause") {
        if (record.state === "draft") return json({ error: "draft pipelines can only be started, edited, or deleted" }, 409);
        if (!ended && record.state !== "paused") {
          record.pausedState = record.state;
          record.state = "paused";
        }
      } else if (body.action === "resume") {
        if (record.state !== "paused") return json({ error: "pipeline is not paused" }, 409);
        record.state = (record.pausedState ?? "running") as Pipeline["state"];
        record.pausedState = null;
      } else if (body.action === "retry-stage" || body.action === "skip-stage") {
        if (record.state !== "needs_decision") return json({ error: "pipeline does not have a stage awaiting a decision" }, 409);
        record.state = "running";
      } else if (body.action === "close") {
        record.state = "closed";
      } else {
        return json({ error: "unsupported in the evidence fixture" }, 400);
      }
      pipelines[index] = record;
      if (evidence.loseNextPipelineAnswer) {
        evidence.loseNextPipelineAnswer = false;
        throw new TypeError("Failed to fetch");
      }
      return json({ pipeline: record });
    }
  }
  if (ACCOUNTS && url.pathname === "/api/accounts" && method === "GET") return json(TIER_LIMITS ? {
    ...accountsBody,
    claude: { ...accountsBody.claude, accounts: accountsBody.claude.accounts.map((row, index) => index === 0
      ? { ...row, limits: { ...tierLimits, state: "fresh", checkedAt: iso(0) } } : row) },
  } : accountsBody);
  if (ACCOUNTS && url.pathname === "/api/account-project-bindings" && method === "GET") {
    return evidence.bindingsUnreadable ? json({ error: "the account binding record is unreadable in the evidence fixture", code: "RECORD_UNREADABLE" }, 409) : json(bindingsBody);
  }
  const migrationRoute = ACCOUNTS && method === "POST" ? /^\/api\/conversations\/([^/]+)\/migration$/.exec(url.pathname) : null;
  if (migrationRoute) {
    const conversationId = decodeURIComponent(migrationRoute[1]!);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.migrationRequests.push({ conversationId, body });
    await new Promise((resolve) => setTimeout(resolve, evidence.accountAnswerDelayMs));
    if (evidence.refuseNextMigrationRequest) {
      const refusal = evidence.refuseNextMigrationRequest;
      evidence.refuseNextMigrationRequest = null;
      return json({ error: refusal.error, code: refusal.code }, refusal.status);
    }
    const index = files.findIndex((entry) => entry.conversationId === conversationId);
    if (body.action === "cancel") {
      /* The engine's guard: a revision and a phase it can still cancel in. */
      const current = index >= 0 ? (files[index] as FileEntry & { migration?: { phase: string; revision?: number } }).migration : undefined;
      if (!current) return json({ error: "conversation has no switch to cancel" }, 404);
      if (current.revision !== body.expectedRevision) return json({ error: "migration revision is stale", code: "MIGRATION_STALE" }, 409);
      if (current.phase !== "requested" && current.phase !== "waiting-turn") return json({ error: "the switch has already started", code: "SWITCH_STARTED" }, 409);
      evidence.setMigration(conversationId, null);
      return json({ id: conversationId, migration: { ...current, phase: "rolled-back" } });
    }
    if (body.action === "withdraw") return json({ withdraw: "withdrawn" });
    return json({ error: "unsupported in the evidence fixture" }, 400);
  }
  if (ACCOUNTS && url.pathname === "/api/conversation-host" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    evidence.accountRequests.push(body);
    await new Promise((resolve) => setTimeout(resolve, evidence.accountAnswerDelayMs));
    if (evidence.refuseNextAccountRequest) {
      const refusal = evidence.refuseNextAccountRequest;
      evidence.refuseNextAccountRequest = null;
      return json({ error: refusal.error }, refusal.status);
    }
    if (evidence.loseNextAccountAnswer) {
      evidence.loseNextAccountAnswer = false;
      throw new TypeError("Failed to fetch");
    }
    const operationId = `account-switch-${evidence.accountRequests.length}`;
    const file = files.find((entry) => entry.path === body.path);
    const outside = file?.engine === "claude" && !CLAUDE_ALLOWED.includes(String(body.accountId));
    return json({ ok: true, structured: true, target: body.conversationId, operationId, receipt: { operationId, status: "queued" }, ...(outside ? { accountOverride: { outsidePool: true, recorded: true } } : {}) }, 202);
  }
  if (url.pathname === "/api/logs" && method === "POST") {
    const { reqs } = JSON.parse(String(init?.body)) as { reqs: Array<{ id: string; path: string; offset: number }> };
    return json({ chunks: Object.fromEntries(reqs.map((req) => {
      if (req.path === evidence.failLogsFor) return [req.id, { error: "transcript read failed in the evidence fixture" }];
      const data = transcriptOf(req.path);
      const size = new TextEncoder().encode(data).length;
      return [req.id, { data: req.offset >= size ? "" : data, start: 0, offset: size, size }];
    })) });
  }
  if (url.pathname === "/api/log") return json({ data: "", start: 0, offset: 0, size: 0 });
  if (url.pathname === "/api/conversations") return json({ items: files, total: files.length, nextCursor: null });
  if (url.pathname === "/api/orchestrator/seat") {
    evidence.seatReads += 1;
    return json({
      seat: {
        project: PROJECT, seatEpoch: 3, conversationId: orchestrator.conversationId, path: orchestrator.path, mandate: "Keep the project moving.",
        promptVersion: null, predecessorConversationId: null, state: "active",
        intent: { clientRequestId: "seat-atlas", mode: "spawn", launchId: null, error: null }, designatedAt: iso(9 * 60 * MIN), activatedAt: iso(9 * 60 * MIN),
      },
      pending: null,
      exists: true,
      viewerMcpRegistered: true,
    });
  }
  /* The rail's footer, so the frames that fold it away (#1802) have something
     to fold: invented machine figures and one invented limit window. */
  if (url.pathname.startsWith("/api/resources")) {
    return json({
      system: { ramTotal: 32 * 1024 ** 3, ramAvailable: 9 * 1024 ** 3, swapTotal: 8 * 1024 ** 3, swapUsed: 1024 ** 3, capturedAt: iso(30) },
      sessions: [],
    });
  }
  if (url.pathname === "/api/limits") {
    return json({
      claude: TIER_LIMITS ? tierLimits : null,
      codex: { session: { usedPercent: 40, resetsAt: now + 3_600, windowMinutes: 300 }, weekly: { usedPercent: 10, resetsAt: now + 172_800, windowMinutes: 10_080 }, plan: "pro", capturedAt: now },
      claudeAccountId: TIER_LIMITS ? "default" : null,
      codexAccountId: null,
      provenance: { claude: { source: TIER_LIMITS ? "live" : "unavailable", reason: null, staleSince: null }, codex: { source: "live", reason: null, staleSince: null } },
      staleSince: null,
    });
  }
  return json({}, 404);
}) as typeof fetch;

/* #1820's scenarios ARE the Overview, which is the view with no project
   selected; every other scenario opens on `atlas`'s own board. */
const OVERVIEW_VIEW = OVERVIEW_SCOPE || OVERVIEW_EMPTY;
if (OVERVIEW_VIEW) localStorage.removeItem("llvProject");
else localStorage.setItem("llvProject", PROJECT);
/* The harness may seed a language before this module runs (`openFixture`), so
   English is only the DEFAULT here — writing it unconditionally turned every
   requested Ukrainian frame back into an English render (#1743). */
if (!localStorage.getItem("llv_lang")) localStorage.setItem("llv_lang", "en");
if (!location.hash && !OVERVIEW_VIEW) location.hash = `#p=${PROJECT}`;
createRoot(document.getElementById("root")!).render(<Viewer />);
