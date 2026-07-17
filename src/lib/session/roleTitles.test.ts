import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { deriveRoleSessionTitles, overlayRoleSessionTitles, taskSubjectLabel } from "./roleTitles";

/*
 * Issue #325 §titles: Viewer-spawned workers carry machine boilerplate titles —
 * the literal scanner fallbacks («Codex session», «Claude session») or the head
 * of the spawn prompt («You are a Builder in tdd mode…»). The role-title
 * projection derives a deterministic, human-scannable presentation title from
 * the durable data: role, board-task text, reviewed subject, and review round.
 * It never rewrites native transcripts — it is a read-model overlay, exactly
 * like the issue #33 custom-title projection that keeps final precedence.
 *
 * Fixtures are production-shaped: durable lineage as /api/files projects it,
 * board tasks as the tasks store serves them, aliases as the registry
 * publishes them.
 */

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: "Claude session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function worker(
  path: string,
  role: string,
  opts: Partial<FileEntry> & { id: string; reviews?: string },
): FileEntry {
  const { id, reviews, ...rest } = opts;
  return entry({
    path,
    conversationId: id,
    durableLineage: {
      kind: reviews ? "review" : "spawn",
      role,
      parentConversationId: "conversation-orchestrator",
      reviewsConversationId: reviews ?? null,
      memberships: [],
    },
    ...rest,
  });
}

function task(overrides: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    project: "demo",
    status: "assigned",
    text: "🧩 #325 — Group review rounds per task\n\nDetails follow…",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

const assignment = (conversationId: string, at = "2026-07-10T01:00:00.000Z") => ({
  path: null,
  conversationId,
  panePid: null,
  state: "delivered" as const,
  error: null,
  at,
});

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function managedFlow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

describe("taskSubjectLabel", () => {
  test("strips leading emoji/bullets, keeps the issue number, caps the length", () => {
    expect(taskSubjectLabel(task({ id: "t" }))).toBe("#325 — Group review rounds per task");
    expect(taskSubjectLabel(task({ id: "t", text: "🔥🔥  ULTRA long subject line that keeps going and going and going and going far past any card" })))
      .toBe("ULTRA long subject line that keeps going and go…");
    expect(taskSubjectLabel(task({ id: "t", text: "  \n\nbody only" }))).toBe("body only");
    expect(taskSubjectLabel(task({ id: "t", text: "🧩🧩🧩" }))).toBeNull();
  });
});

describe("deriveRoleSessionTitles", () => {
  test("a direct single one-shot reviewer gets the task subject, reviewer tag and round 1", () => {
    const builder = worker("/builder", "builder", { id: "conversation-builder", title: "Claude session" });
    const reviewer = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-builder", mtime: 2_000, title: "Codex session", engine: "codex", fmt: "codex", root: "codex-sessions" });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-builder")] });

    const titles = deriveRoleSessionTitles({ files: [builder, reviewer], flows: [], tasks: [boardTask] });

    expect(titles.get("/reviewer-1")).toBe("#325 — Group review rounds per task — reviewer R1");
    expect(titles.get("/builder")).toBe("#325 — Group review rounds per task — builder");
  });

  test("repeated direct rounds number deterministically by transcript age", () => {
    const builder = worker("/builder", "builder", { id: "conversation-builder" });
    const r1 = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-builder", mtime: 2_000 });
    const r2 = worker("/reviewer-2", "reviewer", { id: "conversation-r2", reviews: "conversation-builder", mtime: 3_000 });
    const r3 = worker("/reviewer-3", "reviewer", { id: "conversation-r3", reviews: "conversation-builder", mtime: 4_000 });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-builder")] });

    /* Shuffled input order must not change the numbering — only mtime does. */
    const titles = deriveRoleSessionTitles({ files: [r3, builder, r1, r2], flows: [], tasks: [boardTask] });

    expect(titles.get("/reviewer-1")).toBe("#325 — Group review rounds per task — reviewer R1");
    expect(titles.get("/reviewer-2")).toBe("#325 — Group review rounds per task — reviewer R2");
    expect(titles.get("/reviewer-3")).toBe("#325 — Group review rounds per task — reviewer R3");
  });

  test("multiple implementers on one task share the subject and one round sequence", () => {
    const builderA = worker("/builder-a", "builder", { id: "conversation-a" });
    const builderB = worker("/builder-b", "builder", { id: "conversation-b" });
    const r1 = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-a", mtime: 2_000 });
    const r2 = worker("/reviewer-2", "reviewer", { id: "conversation-r2", reviews: "conversation-b", mtime: 3_000 });
    const boardTask = task({
      id: "task-1",
      assignments: [assignment("conversation-a"), assignment("conversation-b", "2026-07-10T02:00:00.000Z")],
    });

    const titles = deriveRoleSessionTitles({ files: [builderA, builderB, r1, r2], flows: [], tasks: [boardTask] });

    /* The deck groups these rounds under ONE task group — titles must match
       the deck's numbering, not restart per reviewed conversation. */
    expect(titles.get("/reviewer-1")).toBe("#325 — Group review rounds per task — reviewer R1");
    expect(titles.get("/reviewer-2")).toBe("#325 — Group review rounds per task — reviewer R2");
    expect(titles.get("/builder-a")).toBe("#325 — Group review rounds per task — builder");
    expect(titles.get("/builder-b")).toBe("#325 — Group review rounds per task — builder");
  });

  test("distinct tasks never share a subject or a round counter", () => {
    const builderA = worker("/builder-a", "builder", { id: "conversation-a" });
    const builderB = worker("/builder-b", "builder", { id: "conversation-b" });
    const r1 = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-a", mtime: 2_000 });
    const r2 = worker("/reviewer-2", "reviewer", { id: "conversation-r2", reviews: "conversation-b", mtime: 3_000 });
    const taskA = task({ id: "task-a", text: "#101 Fix the deploy gate", assignments: [assignment("conversation-a")] });
    const taskB = task({ id: "task-b", text: "#102 Ship the composer", assignments: [assignment("conversation-b")] });

    const titles = deriveRoleSessionTitles({ files: [builderA, builderB, r1, r2], flows: [], tasks: [taskA, taskB] });

    expect(titles.get("/reviewer-1")).toBe("#101 Fix the deploy gate — reviewer R1");
    expect(titles.get("/reviewer-2")).toBe("#102 Ship the composer — reviewer R1");
  });

  test("a taskless review falls back to the reviewed conversation's own title", () => {
    const implementer = entry({ path: "/impl", conversationId: "conversation-impl", title: "Fix auth bug in login flow" });
    const reviewer = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-impl", mtime: 2_000 });

    const titles = deriveRoleSessionTitles({ files: [implementer, reviewer], flows: [], tasks: [] });

    expect(titles.get("/reviewer-1")).toBe("Fix auth bug in login flow — reviewer R1");
    /* The reviewed conversation itself carries no role — untouched. */
    expect(titles.has("/impl")).toBe(false);
  });

  test("a generic reviewed title is not a subject; the stable fallback is the conversation id tail", () => {
    const implementer = entry({ path: "/impl", conversationId: "conversation_70f08891-3932-47e1-a65d-bd348022981d", title: "Codex session" });
    const reviewer = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation_70f08891-3932-47e1-a65d-bd348022981d", mtime: 2_000 });

    const titles = deriveRoleSessionTitles({ files: [implementer, reviewer], flows: [], tasks: [] });

    expect(titles.get("/reviewer-1")).toBe("70f08891 — reviewer R1");
  });

  test("aliases and generations: the review subject resolves through the alias map and only current generations are titled", () => {
    const archived = entry({ path: "/builder-gen1", conversationId: "conversation-builder", title: "Claude session", migratedTo: "/builder-gen2" });
    const current = worker("/builder-gen2", "builder", { id: "conversation-builder", predecessorPath: "/builder-gen1" });
    const reviewer = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-provisional", mtime: 2_000 });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-builder")] });

    const titles = deriveRoleSessionTitles({
      files: [archived, current, reviewer],
      flows: [],
      tasks: [boardTask],
      conversationAliases: { "conversation-provisional": "conversation-builder" },
    });

    expect(titles.get("/reviewer-1")).toBe("#325 — Group review rounds per task — reviewer R1");
    expect(titles.get("/builder-gen2")).toBe("#325 — Group review rounds per task — builder");
    expect(titles.has("/builder-gen1")).toBe(false);
  });

  test("retroactive rows: production-shaped old reviewers with «Codex session» titles are backfilled", () => {
    /* Mirrors the live registry: durable role=reviewer edges recorded weeks ago,
       generic launch-profile titles, task assigned only to the reviewed side. */
    const builder = worker("/old-builder", "builder", { id: "conversation-old-builder", engine: "codex", fmt: "codex", root: "codex-sessions", title: "Codex session" });
    const r1 = worker("/old-reviewer-1", "reviewer", {
      id: "conversation-old-r1", reviews: "conversation-old-builder",
      engine: "codex", fmt: "codex", root: "codex-sessions", title: "Codex session", mtime: 5_000,
    });
    const r2 = worker("/old-reviewer-2", "reviewer", {
      id: "conversation-old-r2", reviews: "conversation-old-builder",
      engine: "codex", fmt: "codex", root: "codex-sessions", title: "You are the reviewer in an implement-review loop. Working directory: /x", mtime: 6_000,
    });
    const boardTask = task({ id: "task-1", text: "#310 Ledger cursor recovery", assignments: [assignment("conversation-old-builder")] });

    const titles = deriveRoleSessionTitles({ files: [builder, r1, r2], flows: [], tasks: [boardTask] });

    expect(titles.get("/old-reviewer-1")).toBe("#310 Ledger cursor recovery — reviewer R1");
    expect(titles.get("/old-reviewer-2")).toBe("#310 Ledger cursor recovery — reviewer R2");
    expect(titles.get("/old-builder")).toBe("#310 Ledger cursor recovery — builder");
  });

  test("a managed flow reviewer takes its round from the durable membership", () => {
    const implementer = entry({ path: "/impl", conversationId: "conversation-impl" });
    const reviewer = entry({
      path: "/flow-reviewer",
      conversationId: "conversation-fr",
      mtime: 2_000,
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: "conversation-impl",
        reviewsConversationId: "conversation-impl",
        memberships: [{ kind: "flow", containerId: "flow-1", role: "reviewer", slot: "reviewer", stageId: null, stageOrder: null, round: 3, parentConversationId: "conversation-impl" }],
      },
    });
    const flow = managedFlow({ id: "flow-1", implementerPath: "/impl", implementerConversationId: "conversation-impl" });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-impl")] });

    const titles = deriveRoleSessionTitles({ files: [implementer, reviewer], flows: [flow], tasks: [boardTask] });

    expect(titles.get("/flow-reviewer")).toBe("#325 — Group review rounds per task — reviewer R3");
  });

  test("a reviewer claimed by a real flow round is numbered by that round", () => {
    const implementer = entry({ path: "/impl", conversationId: "conversation-impl" });
    const reviewer = worker("/claimed-reviewer", "reviewer", { id: "conversation-fr", reviews: "conversation-impl", mtime: 2_000 });
    const flow = managedFlow({
      id: "flow-1",
      implementerPath: "/impl",
      implementerConversationId: "conversation-impl",
      rounds: [{
        n: 2, reviewerPath: "/claimed-reviewer", reviewerConversationId: "conversation-fr", findingsPath: null,
        triggeredBy: "button", readyNote: null, verdict: null, findingsCount: null,
        startedAt: "2026-07-05T01:00:00Z", reviewedAt: null, terminalAt: null, relayedAt: null, error: null,
      }],
    });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-impl")] });

    const titles = deriveRoleSessionTitles({ files: [implementer, reviewer], flows: [flow], tasks: [boardTask] });

    expect(titles.get("/claimed-reviewer")).toBe("#325 — Group review rounds per task — reviewer R2");
  });

  test("every durable worker role gets the task-plus-role form", () => {
    const boardTask = task({ id: "task-1", text: "#42 Wire the burndown rail" });
    const files = ["architect", "verifier", "deployer", "orchestrator"].map((role, index) =>
      worker(`/${role}`, role, { id: `conversation-${role}`, mtime: 1_000 + index }));
    boardTask.assignments = files.map((file) => assignment(file.conversationId!));

    const titles = deriveRoleSessionTitles({ files, flows: [], tasks: [boardTask] });

    expect(titles.get("/architect")).toBe("#42 Wire the burndown rail — architect");
    expect(titles.get("/verifier")).toBe("#42 Wire the burndown rail — verifier");
    expect(titles.get("/deployer")).toBe("#42 Wire the burndown rail — deployer");
    expect(titles.get("/orchestrator")).toBe("#42 Wire the burndown rail — orchestrator");
  });

  test("stable fallback: a taskless builder keeps its scan title; a self-review carries no round", () => {
    const builder = worker("/builder", "builder", { id: "conversation-builder", title: "Claude session" });
    const selfReviewer = worker("/self", "reviewer", { id: "conversation-self", reviews: "conversation-self", mtime: 2_000 });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-self")] });

    const titles = deriveRoleSessionTitles({ files: [builder, selfReviewer], flows: [], tasks: [boardTask] });

    expect(titles.has("/builder")).toBe(false);
    expect(titles.get("/self")).toBe("#325 — Group review rounds per task — reviewer");
  });

  test("derivation is a pure function: repeated runs and untouched inputs", () => {
    const builder = worker("/builder", "builder", { id: "conversation-builder" });
    const reviewer = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-builder", mtime: 2_000 });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-builder")] });

    const input = { files: [builder, reviewer], flows: [] as Flow[], tasks: [boardTask] };
    const first = deriveRoleSessionTitles(input);
    const second = deriveRoleSessionTitles(input);

    expect([...second.entries()]).toEqual([...first.entries()]);
    expect(builder.title).toBe("Claude session"); // derive never mutates
  });
});

describe("overlayRoleSessionTitles", () => {
  test("backfills presentation titles in place without touching non-role entries", () => {
    const builder = worker("/builder", "builder", { id: "conversation-builder", title: "Claude session" });
    const reviewer = worker("/reviewer-1", "reviewer", { id: "conversation-r1", reviews: "conversation-builder", mtime: 2_000, title: "Codex session" });
    const bystander = entry({ path: "/plain", title: "Codex session" });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-builder")] });

    overlayRoleSessionTitles({ files: [builder, reviewer, bystander], flows: [], tasks: [boardTask] });

    expect(builder.title).toBe("#325 — Group review rounds per task — builder");
    expect(reviewer.title).toBe("#325 — Group review rounds per task — reviewer R1");
    expect(bystander.title).toBe("Codex session");
    /* No override is in play: `autoTitle` must stay unset, or the rename UI
       would read the role title as a user override with a Reset control. */
    expect(builder.autoTitle).toBeUndefined();
  });

  test("an explicit user title (issue #33 override) is preserved; the role title becomes its Reset base", () => {
    const builder = worker("/builder", "builder", {
      id: "conversation-builder",
      title: "My hand-picked name",
      autoTitle: "Claude session",
      titleRevision: 3,
    });
    const boardTask = task({ id: "task-1", assignments: [assignment("conversation-builder")] });

    overlayRoleSessionTitles({ files: [builder], flows: [], tasks: [boardTask] });

    expect(builder.title).toBe("My hand-picked name");
    expect(builder.autoTitle).toBe("#325 — Group review rounds per task — builder");
    expect(builder.titleRevision).toBe(3);
  });
});
