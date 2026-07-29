import crypto from "node:crypto";

import { expect, test } from "bun:test";

import { attentionCallerAuthority, type AttentionCallerSources } from "@/lib/attention/callerAuthority";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";

import { capabilityConversationResolver, hostedConversationsFromSnapshot } from "./bindings";
import { mcpCallerIdentity, permitMcpTool, type ManagerTarget } from "./toolAllowlist";

/* The measured production bug, reproduced end to end through the real pieces:
 *
 * a DESIGNATED orchestrator conversation whose one registry entry recorded
 * BOTH host.agent.pid and structuredHost.process.pid as null — while its host
 * process was alive — resolved to "unidentified" (the pid-ancestry walk had
 * nothing to match) and was refused every manager-only tool with
 * tool_not_permitted. The pids were never recorded, not merely stale, so no
 * amount of "record the pid more reliably" fixes it.
 *
 * The durable model resolves the caller from the spawn capability the Viewer
 * minted at admission and injected into the launch environment. Its digest on
 * the launch receipt names the conversation; the designation seat names the
 * manager; neither depends on a process id.
 */

const MANAGER_ID = "conversation_11111111-1111-4111-8111-111111111111";
const OTHER_ID = "conversation_22222222-2222-4222-8222-222222222222";
const MANAGER_PATH = "/tmp/llv-fixture/manager.jsonl";
const CAPABILITY = "A".repeat(43);
const CAPABILITY_DIGEST = crypto.createHash("sha256").update(CAPABILITY).digest("hex");

/** Snapshot slice mirroring the measured registry state: one conversation, one
    generation, one entry whose host pids were NEVER recorded. */
function nullPidSnapshot() {
  return {
    conversations: {
      [MANAGER_ID]: {
        id: MANAGER_ID,
        generations: [{ path: MANAGER_PATH, launchProfile: { role: "orchestrator" } }],
      },
    },
    entries: {
      "claude:mgr": {
        artifactPath: MANAGER_PATH,
        host: null,
        structuredHost: { process: null },
      },
    },
  } as unknown as Parameters<typeof hostedConversationsFromSnapshot>[0];
}

function activeSeat(conversationId: string, seatEpoch = 1): OrchestratorSeat {
  return {
    project: "proj-a",
    seatEpoch,
    conversationId,
    path: MANAGER_PATH,
    mandate: "own the board",
    promptVersion: null,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req_0000001", mode: "spawn", error: null },
    designatedAt: "2026-07-29T00:00:00.000Z",
    activatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function managerSources(overrides: Partial<ManagerAuthoritySources> = {}): ManagerAuthoritySources {
  return {
    activeSeats: () => [activeSeat(MANAGER_ID)],
    revocations: () => [],
    legacyManagerConversationId: () => MANAGER_ID,
    conversationFacts: (id) => (id === MANAGER_ID ? { superseded: false, hasGeneration: true, project: "proj-a" } : null),
    resolveAlias: (id) => id,
    ...overrides,
  };
}

function callerSources(overrides: Partial<AttentionCallerSources> = {}): AttentionCallerSources {
  return {
    /* The MCP server's ancestry matches NOTHING: the registry recorded no pid
       for the manager's entry, so the walk cannot name it. */
    ancestry: () => [4242, 4241, 1],
    hosted: () => hostedConversationsFromSnapshot(nullPidSnapshot()),
    rootConversationId: () => null,
    capabilityCallerConversationId: capabilityConversationResolver(
      CAPABILITY,
      (digest) => (digest === CAPABILITY_DIGEST ? MANAGER_ID : null),
    ),
    ...overrides,
  };
}

function managerTargetFor(sourcesValue: ManagerAuthoritySources): ManagerTarget {
  return {
    conversationId: null,
    path: null,
    seats: authorizedManagerSeats(sourcesValue).map((seat) => ({ conversationId: seat.conversationId, path: seat.path })),
  };
}

/** The one operation manager identity still gates under B+: minting the
    deployment confirmation nonce. Tool AVAILABILITY is no longer gated. */
const CONFIRMATION_ARGS = {
  clientRequestId: "r1",
  key: "k",
  class: "confirmation_request",
  body: "deploy?",
  confirmation: { sha: "a".repeat(40) },
};

test("pid evidence alone still cannot identify the null-pid manager — the pre-fix behaviour, preserved when no capability exists", () => {
  const authority = attentionCallerAuthority(callerSources({ capabilityCallerConversationId: () => null }));
  expect(authority).toEqual({ kind: "unidentified" });
  const identity = mcpCallerIdentity(authority, managerTargetFor(managerSources()));
  /* Unidentified callers keep the full ordinary surface under B+, but the
     manager-only operation — minting a deploy confirmation — stays refused,
     which is exactly what the measured bug denied the REAL manager. */
  const verdict = permitMcpTool(identity, "bridge_report", CONFIRMATION_ARGS);
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) expect(verdict.code).toBe("confirmation_not_permitted");
});

test("MEASURED BUG: the designated null-pid manager with a live host IS the manager through its launch capability", () => {
  const authority = attentionCallerAuthority(callerSources());
  expect(authority).toEqual({ kind: "worker", conversationId: MANAGER_ID, role: "orchestrator" });
  const target = managerTargetFor(managerSources());
  const identity = mcpCallerIdentity(authority, target);
  expect(identity).toEqual({ kind: "unrestricted", reason: "manager" });
  expect(permitMcpTool(identity, "bridge_report", CONFIRMATION_ARGS).allowed).toBe(true);
});

test("authority is not self-assertable: a capability resolving to nothing stays unidentified", () => {
  const authority = attentionCallerAuthority(callerSources({
    capabilityCallerConversationId: capabilityConversationResolver("B".repeat(43), () => null),
  }));
  expect(authority).toEqual({ kind: "unidentified" });
});

test("conflicting evidence fails closed: ancestry names one conversation, the capability another", () => {
  const snapshot = {
    conversations: {
      [OTHER_ID]: { id: OTHER_ID, generations: [{ path: "/tmp/llv-fixture/other.jsonl", launchProfile: { role: "builder" } }] },
    },
    entries: {
      "claude:other": { artifactPath: "/tmp/llv-fixture/other.jsonl", host: { agent: { pid: 4241 } }, structuredHost: null },
    },
  } as unknown as Parameters<typeof hostedConversationsFromSnapshot>[0];
  const authority = attentionCallerAuthority(callerSources({ hosted: () => hostedConversationsFromSnapshot(snapshot) }));
  expect(authority).toEqual({ kind: "unidentified" });
});

test("a revoked predecessor presenting its still-valid capability holds no manager authority (ABA)", () => {
  const authority = attentionCallerAuthority(callerSources());
  const target = managerTargetFor(managerSources({
    activeSeats: () => [activeSeat(OTHER_ID, 2)],
    revocations: () => [{ project: "proj-a", conversationId: MANAGER_ID, seatEpoch: 1, revokedAt: "2026-07-29T00:00:00.000Z" }],
    legacyManagerConversationId: () => MANAGER_ID,
    conversationFacts: () => ({ superseded: false, hasGeneration: true, project: "proj-a" }),
  }));
  const identity = mcpCallerIdentity(authority, target);
  expect(identity).toEqual({ kind: "unrestricted", reason: "worker" });
  expect(permitMcpTool(identity, "bridge_report", CONFIRMATION_ARGS).allowed).toBe(false);
});

test("authority survives host death and generation change: the same capability keeps resolving after every pid vanished", () => {
  /* Nothing in the authorized path reads a pid: kill the host, roll a new
     generation path, and the capability still names the same conversation. */
  const rolled = {
    conversations: {
      [MANAGER_ID]: { id: MANAGER_ID, generations: [
        { path: MANAGER_PATH, launchProfile: { role: "orchestrator" } },
        { path: "/tmp/llv-fixture/manager-gen2.jsonl", launchProfile: { role: "orchestrator" } },
      ] },
    },
    entries: {},
  } as unknown as Parameters<typeof hostedConversationsFromSnapshot>[0];
  const authority = attentionCallerAuthority(callerSources({ hosted: () => hostedConversationsFromSnapshot(rolled) }));
  expect(authority).toEqual({ kind: "worker", conversationId: MANAGER_ID, role: "orchestrator" });
  const target = managerTargetFor(managerSources());
  expect(mcpCallerIdentity(authority, target)).toEqual({ kind: "unrestricted", reason: "manager" });
});
