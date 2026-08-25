import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";

import { ROTATION_NOTE, readOrchestratorIncumbent, type IncumbentReadDependencies } from "./incumbent";
import { GET } from "./route";

/*
 * The incumbent read (PRD #976 slice B): the panel header's engine/model/account
 * and context %, and the rotation recommendation that until now existed only
 * inside `get_orchestrator`.
 *
 * Everything here runs against an ISOLATED state directory — this suite must
 * never touch the operator's live seats.
 */

/* Everything the route and the seat store resolve their paths from, pointed at
   one throwaway directory: the operator's own agent-log-viewer state, claude
   home and codex home are never opened by this file. */
const ISOLATED = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "HOME", "TMPDIR", "LLV_CLAUDE_HOME", "LLV_CODEX_HOME"] as const;

let sandbox = "";
let previous: Partial<Record<(typeof ISOLATED)[number], string | undefined>> = {};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orch-incumbent-"));
  previous = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
  for (const name of ISOLATED) process.env[name] = sandbox;
});

afterEach(() => {
  for (const name of ISOLATED) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const AT = "2026-08-13T10:00:00.000Z";

/** An active seat for `proj-a`, whose transcript is `bytes` long and — when a
    count is given — ends on a provider-reported usage row the reading prefers. */
function seatWithTranscript(bytes: number, reportedTokens?: number): string {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  const usage = reportedTokens === undefined
    ? ""
    : JSON.stringify({ type: "assistant", message: { usage: { input_tokens: reportedTokens, output_tokens: 12 } } }) + "\n";
  const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) + "\n";
  fs.writeFileSync(transcript, filler.repeat(Math.max(1, Math.round((bytes - usage.length) / filler.length))) + usage, "utf8");
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "run the board", clientRequestId: "req_00000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "req_00000001", conversationId: "conversation_a", path: transcript, now: AT });
  return transcript;
}

function conversation(transcript: string, overrides: { model?: string | null; effort?: string | null; accountId?: string | null } = {}): RegistryConversation {
  return {
    engine: "claude",
    generations: [{
      path: transcript,
      accountId: overrides.accountId === undefined ? "work" : overrides.accountId,
      launchProfile: { model: overrides.model === undefined ? "opus" : overrides.model, effort: overrides.effort ?? null, cwd: "/repos/atlas" },
    }],
  } as unknown as RegistryConversation;
}

function dependencies(overrides: Partial<IncumbentReadDependencies> = {}): IncumbentReadDependencies {
  return {
    conversation: () => null,
    /* No host anywhere: the liveness plane knows nothing about this one. */
    liveness: async () => null,
    sessionCounts: () => null,
    ...overrides,
  };
}

test("a vacant project reports no incumbent at all — never a stale memory of the last one", async () => {
  const body = await readOrchestratorIncumbent("proj-a", dependencies());
  expect(body).toMatchObject({ designated: false, conversationId: null, engine: null, model: null, context: null, rotation: null });
});

test("the incumbent's engine, model, account and context percent are what the header shows", async () => {
  const transcript = seatWithTranscript(4_096, 250_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: (id: ViewerConversationId) => (id === "conversation_a" ? conversation(transcript, { accountId: "work" }) : null),
  }));

  expect(body.designated).toBe(true);
  expect(body.engine).toBe("claude");
  expect(body.model).toBe("opus");
  expect(body.accountId).toBe("work");
  expect(body.cwd).toBe("/repos/atlas");
  /* Provider-reported usage against the opus window policy: 250k of 1M. */
  expect(body.context).toMatchObject({ tokens: 250_000, limit: 1_000_000, percent: 25, estimated: false });
  expect(body.rotation?.recommended).toBe(false);
});

test("reaching the configured threshold RECOMMENDS and says so — and the payload carries no action", async () => {
  const transcript = seatWithTranscript(4_096, 620_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
  }));

  expect(body.context?.percent).toBe(62);
  expect(body.rotation).toMatchObject({ recommended: true, level: "strongly_recommend", advisory: "STRONGLY_RECOMMEND_ROTATION" });
  expect(body.rotation?.reasons[0]).toContain("rotation threshold");
  expect(body.rotation?.threshold).toMatchObject({ windowTokens: 1_000_000, thresholdTokens: 500_000, policy: "claude-opus-1m" });
  /* WORDS ONLY: the whole payload is data, and it says so in its own note. */
  expect(body.rotation?.note).toBe(ROTATION_NOTE);
  expect(JSON.stringify(body)).not.toContain("rotate_orchestrator\":");
});

test("a model with no window policy states the usage it can prove and calls the threshold unknown", async () => {
  const transcript = seatWithTranscript(2_048, 90_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => ({ ...conversation(transcript), engine: "codex" }) as RegistryConversation,
  }));

  expect(body.context).toMatchObject({ tokens: 90_000, limit: null, percent: null });
  expect(body.rotation).toMatchObject({ recommended: false, thresholdUnknown: true, threshold: null });
});

test("compactions recorded in the transcript are their own recommendation reason", async () => {
  const transcript = seatWithTranscript(2_048, 10_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
    sessionCounts: () => ({ messages: 400, tools: 900, compactions: 3 }),
  }));

  expect(body.transcriptFacts).toMatchObject({ messageCount: 400, toolCount: 900, compactionCount: 3 });
  expect(body.rotation).toMatchObject({ recommended: true, level: "recommend" });
  expect(body.rotation?.reasons.join(" ")).toContain("compaction");
});

test("an unsettled registry generation reads as unknown rather than inventing a model to judge by", async () => {
  seatWithTranscript(2_048, 900_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({ conversation: () => null }));

  expect(body.designated).toBe(true);
  expect(body.engine).toBeNull();
  expect(body.model).toBeNull();
  /* No engine, so no window policy, so no threshold is claimed either way. */
  expect(body.context?.limit).toBeNull();
  expect(body.rotation?.level).toBe("none");
});

test("a liveness plane that throws says nothing — it never invents a dead host as a rotation reason", async () => {
  const transcript = seatWithTranscript(2_048, 10_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
    liveness: async () => {
      throw new Error("the liveness plane is unavailable");
    },
  }));

  expect(body.liveness).toBeNull();
  expect(body.rotation).toMatchObject({ recommended: false, level: "none" });
});

test("a host the liveness plane reports GONE is a recommendation reason, and the health it reports rides along", async () => {
  const transcript = seatWithTranscript(2_048, 10_000);
  const body = await readOrchestratorIncumbent("proj-a", dependencies({
    conversation: () => conversation(transcript),
    liveness: async () => ({ lifecycle: "gone", hostState: "absent", silentForMs: 900_000 }),
  }));

  expect(body.liveness).toMatchObject({ lifecycle: "gone", hostState: "absent", silentForMs: 900_000 });
  expect(body.rotation).toMatchObject({ recommended: true, level: "recommend" });
  expect(body.rotation?.reasons.join(" ")).toContain("host is gone");
});

test("the route answers the read, and refuses a request that names no project", async () => {
  seatWithTranscript(1_024);
  const missing = await GET(new NextRequest("http://127.0.0.1/api/orchestrator/seat/status"));
  expect(missing.status).toBe(400);

  const answer = await GET(new NextRequest("http://127.0.0.1/api/orchestrator/seat/status?project=proj-a"));
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ project: "proj-a", designated: true, conversationId: "conversation_a" });
});
