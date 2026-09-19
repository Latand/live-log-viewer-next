/*
 * The page `issue1671Evidence.browser.test.tsx` drives: the real Viewer over an
 * invented phone board — ten lanes waiting on a decision, one running
 * conversation, thirty finished ones and a 46-entry stored catalog — answered
 * by an in-page fetch double. Board writes go through the product's own
 * reducer, and every write is recorded on `window.evidence`, so the driver
 * reads what a gesture really sent. All data is invented.
 */
import { createRoot } from "react-dom/client";

import { Viewer } from "@/components/Viewer";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

const PROJECT = "atlas";
const now = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1_000).toISOString();
/* A real close spends seconds stopping the lane's hosts before it answers. */
const CLOSE_ANSWER_MS = 2_500;

function conversation(path: string, title: string, over: Record<string, unknown> = {}): FileEntry {
  return {
    path, root: "claude-projects", name: path.split("/").pop(), project: PROJECT, title, engine: "claude", kind: "session",
    fmt: "claude", parent: null, mtime: now - 900, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
    pendingQuestion: null, waitingInput: null, conversationId: `conversation_${(path.split("/").pop() ?? "").replace(".jsonl", "")}`,
    ...over,
  } as unknown as FileEntry;
}

const TASKS = [
  "Fast conversation switching", "Stage verdict recovery after a host restart", "Seat rotation keeps the mandate",
  "Queue drain on reconnect", "Archive TTL for closed lanes", "Deploy gate reads the pinned runtime",
  "Catalog pages stay in snapshot order", "Voice utterances render once", "Held deliveries heal themselves",
  "Board zoom keeps the focused card",
];

function lane(id: string, task: string, attempts: unknown[], over: Record<string, unknown> = {}): Pipeline {
  return {
    id, task, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `lane/${id}`,
    baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: [
      { id: "implement", kind: "run", effectiveRole: { roleId: "builder", access: "read-write", promptScaffold: null } },
      { id: "review", kind: "review-loop", effectiveRole: { roleId: "reviewer", access: "read-only", promptScaffold: null } },
    ],
    runs: [{ stageId: "review", attempts }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: iso(7_200), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

const failedRound = (n: number, startedAgo: number, completedAgo: number, findings = 1) => ({
  n, state: "failed", startedAt: iso(startedAgo), completedAt: iso(completedAgo),
  /* Every recorded attempt carries the role it ran under; the desktop board's
     task projection reads it without a guard, and a round without one took the
     whole board down when this fixture was first opened at desktop width. */
  effectiveRole: { roleId: "reviewer", access: "read-only", promptScaffold: null },
  verdict: { status: "fail", findings: Array.from({ length: findings }, (_, i) => `finding ${i + 1}`) },
});

const pipelines = [
  ...TASKS.map((task, i) => lane(`lane-${i}`, task, [failedRound(1 + (i % 3), 3_600 * (i + 1) + 600, 3_600 * (i + 1), 1 + (i % 4))], { createdAt: iso(7_200 * (i + 1)) })),
  /* A Hide covers the decision it saw (#1671): this lane was hidden after the
     round that parked it and has not moved since, so it stays off the board. */
  lane("lane-hidden", "Seat tick accounting survives a restart", [failedRound(1, 6_000, 5_400)], { dismissedAt: iso(4_800) }),
  /* ...and this one was hidden, retried, and parked again on a round that
     started after the Hide: a decision nobody hid, back in Needs you. */
  lane("lane-parked-again", "Board bands keep their order", [failedRound(1, 9_000, 8_400), failedRound(2, 3_000, 2_400)], { dismissedAt: iso(7_800) }),
];

/* The running conversation lives under a managed account home, the way a real
   transcript of a managed account does, so the surfaces that name the account
   (#1795) have a real one to name rather than the legacy default. The id is
   `?account=` so one page can be asked for a long one, which is what crowds a
   390 px meta line. */
const ACCOUNT = new URLSearchParams(location.search).get("account") || "spare";
const RUNNING_PATH = `/state/agent-log-viewer/shared/accounts/claude/${ACCOUNT}/projects/atlas/running.jsonl`;
/* #1846: `&runtime=structured` puts the running conversation on a structured host, mid-turn, so its runtime
   pill picks an account for the conversation itself; `&next=` names the account ready to take the next
   message, which with a long running id is what the title line has to hold as well. */
const STRUCTURED = new URLSearchParams(location.search).get("runtime") === "structured";
const NEXT_ACCOUNT = new URLSearchParams(location.search).get("next") || "relief";

/* With the deck asked for (#1795 below), the running conversation is the round
   under review, and says so the way a reviewer transcript does. */
const deckRequested = new URLSearchParams(location.search).has("deck");
const reviewerLineage = deckRequested
  ? { durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation_done-0", reviewsConversationId: "conversation_done-0", memberships: [] } }
  : {};

const files: FileEntry[] = [
  conversation(RUNNING_PATH, "Rebuild the board status projection", {
    activity: "live", proc: "running", pid: 4_401, mtime: now - 20,
    /* A real launch model, not a one-word one: the bar line has to hold
       `fable-5-1 · high` beside the state phrase and the account (#1795). */
    model: "fable-5-1", effort: "high",
    ...reviewerLineage,
    lastTurn: { startedAt: (now - 400) * 1_000, endedAt: null },
  }),
  ...Array.from({ length: 30 }, (_, i) => conversation(
    `/repo/done-${i}.jsonl`,
    i === 0 ? "A long finished conversation title that has to stay inside the phone row while its tray opens" : `Finished conversation ${i + 1}`,
    { mtime: now - 900 - i * 600, activity: i < 2 ? "recent" : "idle", engine: i % 3 === 1 ? "codex" : "claude", model: i % 3 === 1 ? "gpt-5.6" : "opus" },
  )),
];
const catalog = Array.from({ length: 45 }, (_, i) => conversation(`/repo/history-${i}.jsonl`, `Stored conversation ${i + 1}`, { mtime: now - 90_000 - i * 3_600 }));
/* A superseded round only the stored catalog still lists, as the conversations
   route marks it (#1671): the board never shows it. */
catalog.splice(5, 0, conversation("/repo/superseded-round.jsonl", "Superseded review round", {
  mtime: now - 95_000,
  supersededBy: { conversationId: "conversation_history-5", path: "/repo/history-5.jsonl", at: iso(94_000), reason: "stage-retry" },
}));

/* #1795 asks for the surface the operator hit: a review round opened from the
   board, whose pane the round deck mounts on a perspective stage. It is added
   only when the page is asked for it (`?deck=1`), so every other case on this
   fixture keeps the board it has always had. */
const flows = deckRequested ? [{
  id: "flow-review", project: PROJECT, state: "reviewing",
  implementerPath: "/repo/done-0.jsonl", implementerConversationId: "conversation_done-0",
  rounds: [{ n: 1, reviewerPath: RUNNING_PATH, reviewerConversationId: "conversation_running", verdict: null, error: null, startedAt: iso(300) }],
}] : [];

let board = {
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
} as unknown as BoardProjectStateV1;

const evidence = {
  catalogRequests: [] as string[],
  /* Every reconfigure the runtime pill sends, so a re-tap of the tier the
     conversation already runs on can be shown to send nothing (#1795). */
  runtimeRequests: [] as Array<Record<string, unknown>>,
  /* Every account select, the one path that moves the next message. */
  accountSelects: [] as Array<{ engine: string; body: unknown }>,
  pipelinePatches: [] as Array<{ id: string; action: string }>,
  closesAnswered: [] as string[],
  hidesAnswered: [] as Array<{ id: string; action: string; dismissedAt: string | null }>,
  boardMutations: [] as BoardMutationV1[],
  refuseNextPipelinePatch: false,
  /* Holds each pipeline answer this long, so a step can watch the frames
     painted while its requests are out. */
  pipelineAnswerDelayMs: 0,
};
Object.assign(window, { evidence });

/* No log stream in the fixture: the source fails at once, the way a Viewer
   behind a proxy that drops SSE does, and the bus falls back to the file poll
   the fixture answers below. Without the failure it waits on a stream that
   never opens and the feed behind the sheet stays empty. */
class QuietEventSource {
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    setTimeout(() => this.onerror?.(new Event("error")), 0);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
Object.assign(window, { EventSource: QuietEventSource });

/** The account future launches use; a select moves it, as on the server. */
let activeAccount = ACCOUNT;

/* A transcript with something in it, so the feed behind the sheet is a real
   scrolled feed — its rows, and its own down button, are what floated over the
   sheet in the operator's screenshot. All invented. */
const FEED = `${Array.from({ length: 24 }, (_, i) => (i % 2 === 0
  ? JSON.stringify({
    type: "user", uuid: `evidence-u-${i}`, timestamp: iso(2_400 - i * 60), sessionId: "conversation_running",
    message: { role: "user", content: `Replay band ${i + 1} and say what moved.` },
  })
  : JSON.stringify({
    type: "assistant", uuid: `evidence-a-${i}`, timestamp: iso(2_400 - i * 60), sessionId: "conversation_running",
    message: {
      role: "assistant", model: "claude-fable-5-1",
      content: [{ type: "text", text: `Band ${i} replayed from the snapshot: the projection matches, and nothing outside it moved.` }],
    },
  }))).join("\n")}\n`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/files") {
    return json({
      files, projectCatalog: [{ project: PROJECT, conversations: files.length }], flows, pipelines,
      workflows: [], tasks: [], systemHealth: { tmux: { status: "healthy" } },
    });
  }
  /* The fixture has no runtime plane, and says so the way a Viewer without one
     does. Left unanswered, the bus escalated to «Runtime degraded» part-way
     through a run, and the banner moved the list under a measured tap. */
  if (url.pathname === "/api/runtime/snapshot" && STRUCTURED) {
    return json({
      schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
      sessions: [{
        conversationId: "conversation_running", sessionKey: { engine: "claude", sessionId: "running-session" }, hostKind: "claude-broker", host: "hosted",
        turn: "running", provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: ACCOUNT,
        parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo", artifactPath: RUNNING_PATH,
        capabilities: { steer: false, structuredAttention: true }, activeTurnId: "turn-1", pendingReconfigure: null,
      }],
      attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
    });
  }
  if (url.pathname === "/api/runtime/snapshot") return json({ code: RUNTIME_PLANE_ABSENT }, 503);
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
  if (url.pathname === "/api/conversations") {
    evidence.catalogRequests.push(url.search);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return json({ items: catalog.slice(offset, offset + limit), total: 4_595, nextCursor: offset + limit < catalog.length ? String(offset + limit) : null });
  }
  if (url.pathname === "/api/orchestrator/seat") return json({ seat: null, pending: null, exists: true });
  /* The feed's poll transport (the fixture has no log stream). */
  if (url.pathname === "/api/logs" && method === "POST") {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { reqs?: Array<{ id: string; path: string; offset: number }> };
    const chunks: Record<string, { offset: number; start: number; size: number; data: string }> = {};
    (asked.reqs ?? []).forEach((request, index) => {
      const body = request.path === RUNNING_PATH ? FEED : "";
      const from = Math.min(Math.max(request.offset, 0), body.length);
      chunks[String(index)] = { offset: body.length, start: from, size: body.length, data: body.slice(from) };
    });
    return json({ chunks });
  }
  /* Three invented Claude accounts: the one the running conversation is on,
     one ready to take the next message, one signed out. */
  if (url.pathname === "/api/accounts") {
    return json({
      claude: {
        active: activeAccount,
        accounts: [
          { id: ACCOUNT, label: ACCOUNT, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
          { id: NEXT_ACCOUNT, label: NEXT_ACCOUNT, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
          { id: "dormant", label: "dormant", kind: "managed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null },
        ],
        migration: null, autoBalance: null,
      },
      codex: { active: "", accounts: [], migration: null, autoBalance: null },
    });
  }
  if (url.pathname === "/api/accounts/claude/active" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "null")) as { id?: string; mode?: string } | null;
    evidence.accountSelects.push({ engine: "claude", body });
    /* The server answers every later read with the account that was picked. */
    if (body?.mode === "select" && typeof body.id === "string") activeAccount = body.id;
    return json({ ok: true });
  }
  if (url.pathname === "/api/tmux" && method === "POST") {
    evidence.runtimeRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json(STRUCTURED ? { ok: true, structured: true } : { ok: true, outcome: "pending", operationId: "reconfigure-evidence" });
  }
  if (url.pathname.startsWith("/api/pipelines/") && method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const body = JSON.parse(String(init?.body)) as { action: string };
    evidence.pipelinePatches.push({ id, action: body.action });
    if (evidence.refuseNextPipelinePatch) {
      evidence.refuseNextPipelinePatch = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return json({ error: "refused by the evidence fixture" }, 409);
    }
    const found = pipelines.find((pipeline) => pipeline.id === id);
    if (!found) return json({ error: "pipeline not found" }, 404);
    if (evidence.pipelineAnswerDelayMs) await new Promise((resolve) => setTimeout(resolve, evidence.pipelineAnswerDelayMs));
    /* The engine's own rule: a lane already hidden keeps its first Hide
       instant through a later dismiss, and undismiss clears it. */
    if (body.action === "dismiss") found.dismissedAt = found.dismissedAt ?? new Date().toISOString();
    if (body.action === "undismiss") found.dismissedAt = null;
    if (body.action === "dismiss" || body.action === "undismiss") evidence.hidesAnswered.push({ id, action: body.action, dismissedAt: found.dismissedAt ?? null });
    if (body.action === "close") {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_ANSWER_MS));
      Object.assign(found, { state: "closed", closedAt: new Date().toISOString(), hiddenAt: new Date().toISOString() });
      evidence.closesAnswered.push(id);
    }
    return json({ ok: true, pipeline: found });
  }
  return json({}, 404);
}) as typeof fetch;

localStorage.setItem("llvProject", PROJECT);
if (!location.hash) location.hash = `#p=${PROJECT}`;
createRoot(document.getElementById("root")!).render(<Viewer />);
