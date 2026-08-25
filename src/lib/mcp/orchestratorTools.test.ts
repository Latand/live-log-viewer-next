import crypto from "node:crypto";

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { requireOperatorAuthority, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { persistProjectAliases } from "@/lib/projects/aliases";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";

/*
 * The two-axis orchestration surface: get / create / send / rotate. All four
 * are ordinary tools available to every session; designation changes flow
 * through the seat routes (durable intents, idempotent), reads come off the
 * durable stores, and nothing here rotates anything on its own.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orch-tools-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const AT = "2026-07-29T00:00:00.000Z";
const SEATED_ID = "conversation_66666666-6666-4666-8666-666666666666";

function seatActive(project: string, conversationId: string, transcriptPath: string | null): void {
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId: "seed_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project, clientRequestId: "seed_0000001", conversationId, path: transcriptPath, now: AT });
}

function controlStub(responses: Record<string, Record<string, unknown>> = {}) {
  const posts: { pathname: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, body, headers) => {
      posts.push({ pathname, body, headers: headers ?? {} });
      return responses[pathname] ?? { ok: true, outcome: "delivered" };
    },
  };
  return { posts, control };
}

/** A control plane whose DESIGNATION endpoints run the REAL operator gate
    against exactly the headers the binding forwarded — the same check the seat
    and rotation routes make first, without reaching a real spawn. */
function gatedControlStub() {
  const designations: string[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, _body, headers) => {
      if (pathname === "/api/orchestrator/seat" || pathname === "/api/orchestrator/rotate") {
        const operator = requireOperatorAuthority({ headers: new Headers(headers ?? {}) });
        if (!operator.ok) throw new Error(operator.error);
        designations.push(pathname);
        return { ok: true, conversationId: SEATED_ID, seat: { conversationId: SEATED_ID } };
      }
      return { ok: true, outcome: "delivered" };
    },
  };
  return { designations, control };
}

function bindingsWith(control: ViewerControlDependencies) {
  return viewerMcpBindings(undefined, control, {} as never);
}

test("get_orchestrator with nothing designated says so and names the current default prompt version", async () => {
  const { control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-1", project: "proj-a" });
  expect(result).toMatchObject({
    project: "proj-a",
    designated: false,
    seat: null,
    health: null,
    rotation: null,
    defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
    lineage: [],
  });
});

test("get_orchestrator reports health with labelled estimates and a recommendation-only rotation block", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, `${"x".repeat(400_000)}\n`, "utf8");
  seatActive("proj-a", SEATED_ID, transcript);

  const { control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-2", project: "proj-a" }) as Record<string, unknown>;

  expect(result.designated).toBe(true);
  expect(result.conversationId).toBe(SEATED_ID);
  const health = result.health as { transcript: { bytes: number; megabytes: number }; context: { estimated: boolean; basis: string } };
  expect(health.transcript.bytes).toBe(400_001);
  expect(health.transcript.megabytes).toBeCloseTo(0.38, 1);
  /* No provider usage in that file, so the reading is labelled an estimate. */
  expect(health.context.estimated).toBe(true);
  expect(health.context.basis).toContain("ESTIMATE");
  const rotation = result.rotation as { recommended: boolean; reasons: string[]; note: string };
  expect(rotation.note).toContain("never happens automatically");
});

test("crossing the rotation threshold changes WORDS ONLY: prominent advisory, zero side effects", async () => {
  const transcript = path.join(sandbox, "hot-orchestrator.jsonl");
  /* Provider-reported usage far over the reference threshold (500k of 1M). */
  fs.writeFileSync(transcript, JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 600_000, cache_read_input_tokens: 50_000 } },
  }) + "\n", "utf8");
  const begun = agentRegistry().beginSpawnRequest({
    engine: "claude",
    cwd: sandbox,
    clientAttemptId: "seed_0000001",
    launchProfile: { model: "opus" },
  });
  seatActive("proj-a", begun.receipt.conversationId, transcript);
  const before = JSON.stringify(orchestratorSeatFor("proj-a"));

  const { posts, control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-hot", project: "proj-a" }) as Record<string, unknown>;

  expect(result.engine).toBe("claude");
  expect(result.model).toBe("opus");
  const rotation = result.rotation as { level: string; advisory: string | null; reasons: string[] };
  expect(rotation.level).toBe("strongly_recommend");
  expect(rotation.advisory).toBe("STRONGLY_RECOMMEND_ROTATION");

  /* The absence of side effects, asserted rather than assumed: no control-plane
     call of any kind (no rotate, no create, no message, no interrupt), and the
     designation exactly as it was — same seat, no pending intent, no
     revocation. The incumbent was not touched in any way. */
  expect(posts).toEqual([]);
  expect(JSON.stringify(orchestratorSeatFor("proj-a"))).toBe(before);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
});

test("get_orchestrator surfaces bidirectional predecessor lineage after a replacement", async () => {
  seatActive("proj-a", "conversation_old", null);
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "v2", clientRequestId: "seed_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "seed_0000002", conversationId: SEATED_ID, path: null, now: AT });

  const { control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-3", project: "proj-a" }) as Record<string, unknown>;
  expect(result.predecessorConversationId).toBe("conversation_old");
  expect(result.lineage).toEqual([{
    conversationId: "conversation_old",
    seatEpoch: 1,
    revokedAt: AT,
    successorConversationId: SEATED_ID,
  }]);
});

test("get and send resolve a named project alias to its canonical orchestrator seat", async () => {
  const canonical = "repo-0123456789abcdef0123456789abcdef";
  expect(persistProjectAliases([
    { source: "named-project", target: canonical, displayName: "named-project" },
  ])).toBe(true);
  seatActive(canonical, SEATED_ID, "/tmp/o.jsonl");

  const { control } = controlStub();
  const status = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-alias", project: "named-project" });
  const delivery = await bindingsWith(control).send_message_to_orchestrator({
    clientRequestId: "send-alias",
    project: "named-project",
    text: "status?",
  });

  expect(status).toMatchObject({ project: canonical, designated: true, conversationId: SEATED_ID });
  expect(delivery).toMatchObject({ project: canonical, conversationId: SEATED_ID, created: false });
});

test("create_orchestrator posts the versioned approved default mandate through the seat route", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": { ok: true, conversationId: SEATED_ID, path: "/tmp/o.jsonl", seat: { conversationId: SEATED_ID }, state: "settled" },
  });
  const result = await bindingsWith(control).create_orchestrator({ clientRequestId: "create-1", project: "proj-a" });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/seat");
  expect(posts[0]!.body).toMatchObject({
    project: "proj-a",
    mandate: ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    clientRequestId: "create-1",
  });
  expect(result).toMatchObject({ conversationId: SEATED_ID, transcriptPath: "/tmp/o.jsonl" });
});

test("create_orchestrator rejects an explicit fresh-launch model outside the engine catalog before posting", async () => {
  const { posts, control } = controlStub();

  await expect(bindingsWith(control).create_orchestrator({
    clientRequestId: "create-invalid-model",
    project: "proj-a",
    engine: "claude",
    model: "claude-fable-5",
  })).rejects.toThrow("invalid claude model id \"claude-fable-5\"; valid claude model ids: opus, fable, sonnet, haiku");

  expect(posts).toEqual([]);
});

test("create_orchestrator adopts an eligible existing conversation through the seat route", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": { ok: true, conversationId: SEATED_ID, path: "/tmp/o.jsonl", seat: { conversationId: SEATED_ID }, state: "settled" },
  });

  const result = await bindingsWith(control).create_orchestrator({
    clientRequestId: "adopt-01",
    project: "proj-a",
    conversationId: SEATED_ID,
    model: "historical-provider-model",
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/seat");
  expect(posts[0]!.body).toMatchObject({
    project: "proj-a",
    conversationId: SEATED_ID,
    model: "historical-provider-model",
    clientRequestId: "adopt-01",
  });
  expect(result).toMatchObject({ conversationId: SEATED_ID, transcriptPath: "/tmp/o.jsonl" });
});

test("create_orchestrator reports an accepted asynchronous launch with durable identifiers", async () => {
  const { control } = controlStub({
    "/api/orchestrator/seat": {
      ok: true,
      accepted: true,
      state: "accepted",
      conversationId: SEATED_ID,
      launchId: "launch_async",
      seat: { conversationId: SEATED_ID },
    },
  });

  const result = await bindingsWith(control).create_orchestrator({
    clientRequestId: "accepted-01",
    project: "proj-a",
  });

  expect(result).toMatchObject({
    accepted: true,
    state: "accepted",
    conversationId: SEATED_ID,
    launchId: "launch_async",
  });
});

test("send_message_to_orchestrator resolves the seat server-side and delivers with the caller's idempotency key", async () => {
  seatActive("proj-a", SEATED_ID, "/tmp/o.jsonl");
  const { posts, control } = controlStub();
  const result = await bindingsWith(control).send_message_to_orchestrator({ clientRequestId: "send-1", project: "proj-a", text: "status?" });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/tmux");
  /* The delivery seam resumes a dead selected conversation on this same call —
     no duplicate is ever spawned for a session that merely died. */
  expect(posts[0]!.body).toMatchObject({
    conversationId: SEATED_ID,
    path: "/tmp/o.jsonl",
    clientMessageId: "send-1",
    text: "status?",
  });
  expect(result).toMatchObject({ conversationId: SEATED_ID, created: false });
});

test("send_message_to_orchestrator with nothing designated creates one first, then delivers — with derived keys and visible lineage", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": {
      ok: true,
      conversationId: SEATED_ID,
      seat: { conversationId: SEATED_ID, path: "/tmp/fresh.jsonl", seatEpoch: 1, predecessorConversationId: null },
    },
  });
  const result = await bindingsWith(control).send_message_to_orchestrator({ clientRequestId: "send-2", project: "proj-a", text: "kick off" });

  expect(posts.map((post) => post.pathname)).toEqual(["/api/orchestrator/seat", "/api/tmux"]);
  /* The creation key derives from the caller's, so a retried call replays both
     side effects instead of creating a second orchestrator. */
  expect(posts[0]!.body.clientRequestId).not.toBe("send-2");
  expect(posts[0]!.body).toMatchObject({ mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: ORCHESTRATOR_PROMPT_VERSION });
  expect(posts[1]!.body).toMatchObject({ conversationId: SEATED_ID, clientMessageId: "send-2", text: "kick off" });
  expect(result).toMatchObject({ created: true, conversationId: SEATED_ID, seatEpoch: 1 });
});

/* ── BLOCKING 1: designation is an OPERATION contract, not self-service ──── */

const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");
let previousCapability: string | undefined;

function asCapabilityCaller(): void {
  previousCapability = process.env.LLV_SPAWN_CAPABILITY;
  process.env.LLV_SPAWN_CAPABILITY = WORKER_CAPABILITY;
  setCallerConversationResolverForTests((digest) =>
    digest === crypto.createHash("sha256").update(WORKER_CAPABILITY).digest("hex")
      ? "conversation_worker"
      : null);
}

function restoreCapabilityCaller(): void {
  if (previousCapability === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
  else process.env.LLV_SPAWN_CAPABILITY = previousCapability;
  setCallerConversationResolverForTests(null);
}

test("a NON-OPERATOR caller cannot designate itself or anyone: create, rotate and send's create branch are refused by the real operator gate, writing nothing — while the tools stay callable", async () => {
  asCapabilityCaller();
  try {
    const { designations, control } = gatedControlStub();
    const tools = bindingsWith(control);

    /* All three designation paths run — the tools are ON the surface for this
       session (axis 1) — and every one is refused by the gate that reads the
       forwarded conversation capability, before anything durable changes. */
    await expect(tools.create_orchestrator({
      clientRequestId: "create-x",
      project: "proj-a",
      conversationId: "conversation_worker",
    })).rejects.toThrow();
    await expect(tools.rotate_orchestrator({ clientRequestId: "rotate-x", project: "proj-a" })).rejects.toThrow();
    await expect(tools.send_message_to_orchestrator({ clientRequestId: "send-x", project: "proj-a", text: "hi" })).rejects.toThrow();

    expect(designations).toEqual([]);
    const { active, pending } = orchestratorSeatFor("proj-a");
    expect(active).toBeNull();
    expect(pending).toBeNull();
  } finally {
    restoreCapabilityCaller();
  }
});

test("an operator-lane caller (no conversation capability) still designates through the same gate", async () => {
  const { designations, control } = gatedControlStub();
  const result = await bindingsWith(control).create_orchestrator({ clientRequestId: "create-y", project: "proj-a" });
  expect(designations).toEqual(["/api/orchestrator/seat"]);
  expect(result).toMatchObject({ conversationId: SEATED_ID });
});

test("the adoption target reaches the authorized seat route while prompt provenance stays server-owned", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": { ok: true, conversationId: SEATED_ID, seat: { conversationId: SEATED_ID } },
  });
  await bindingsWith(control).create_orchestrator({
    clientRequestId: "create-z",
    project: "proj-a",
    /* Route-level operator authorization decides whether this existing
       conversation can be adopted. Prompt provenance remains server-owned. */
    conversationId: "conversation_worker",
    promptVersion: 99,
  });
  expect(posts[0]!.body.conversationId).toBe("conversation_worker");
  expect(posts[0]!.body.promptVersion).toBe(ORCHESTRATOR_PROMPT_VERSION);

  await bindingsWith(control).rotate_orchestrator({
    clientRequestId: "rotate-z",
    project: "proj-a",
    conversationId: "conversation_worker",
    promptVersion: 99,
  });
  const rotate = posts.find((post) => post.pathname === "/api/orchestrator/rotate");
  expect(rotate!.body).not.toHaveProperty("conversationId");
  expect(rotate!.body).not.toHaveProperty("promptVersion");
});

test("rotate_orchestrator forwards the requested effort to the rotation route so it reaches the successor spawn", async () => {
  const { posts, control } = controlStub({ "/api/orchestrator/rotate": { ok: true } });
  await bindingsWith(control).rotate_orchestrator({
    clientRequestId: "rotate-effort",
    project: "proj-a",
    effort: "medium",
  });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body.effort).toBe("medium");
});

test("rotate_orchestrator relays to the rotation route and reports the lineage it produced", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/rotate": {
      ok: true,
      conversationId: SEATED_ID,
      seat: { conversationId: SEATED_ID },
      rotatedFrom: { conversationId: "conversation_old", seatEpoch: 1 },
    },
  });
  const result = await bindingsWith(control).rotate_orchestrator({
    clientRequestId: "rotate-1",
    project: "proj-a",
    handoffNotes: "prioritize reviews",
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/rotate");
  expect(posts[0]!.body).toMatchObject({ project: "proj-a", handoffNotes: "prioritize reviews", clientRequestId: "rotate-1" });
  expect(result).toMatchObject({ rotatedFrom: { conversationId: "conversation_old" } });
});
