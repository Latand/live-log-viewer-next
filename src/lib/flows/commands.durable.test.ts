import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINE_MODELS } from "@/lib/agent/models";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-durable-create-"));
process.env.LLV_STATE_DIR = sandbox;

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { cancelRound, closeFlow, createFlowFromRequest, patchFlow } = await import("./commands");
const { newRound, relayClientMessageId } = await import("./engine");
const { startHeadlessReview } = await import("./exec");
const { loadFlows, saveFlows } = await import("./store");

const registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "off" });
setAgentRegistryForTests(registry);

afterAll(() => {
  setAgentRegistryForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("durable implementer identity creates a flow without scanner or live-host evidence", async () => {
  saveFlows([]);
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);

  const result = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    targetSha: "12AD73656844D3583D44AE718D003C7F2F2C6ACE",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);

  expect(result.error).toBeUndefined();
  expect(result.flow).toMatchObject({
    cwd: "/repo",
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    kickoffDelivery: null,
    targetSha: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    state: "waiting_ready",
  });
});

test("flow creation returns the catalog error before persisting an unknown reviewer model", async () => {
  saveFlows([]);
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);

  const result = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-fabricated", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);

  expect(result).toEqual({
    error: `invalid codex model id "gpt-fabricated"; valid codex model ids: ${ENGINE_MODELS.codex.map((option) => option.id).join(", ")}`,
    status: 400,
  });
  expect(loadFlows()).toEqual([]);
});

test("closeFlow rejects a replacement reviewer binding while preserving concurrent flows", async () => {
  saveFlows([]);
  const executablePath = path.join(sandbox, "delayed-reviewer");
  fs.writeFileSync(executablePath, `#!${process.execPath}\nprocess.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));\nsetInterval(() => {}, 1_000);\n`, { mode: 0o700 });
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);
  const created = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);
  const flow = created.flow!;
  const round = newRound(flow, "button", null);
  flow.rounds.push(round);
  flow.state = "reviewing";
  const launched = startHeadlessReview(
    flow.id,
    round.n,
    flow.roles.reviewer,
    sandbox,
    "review",
    5_000,
    null,
    null,
    { command: executablePath },
  );
  round.reviewerPid = launched.pid;
  round.reviewerIdentity = launched.identity;
  saveFlows([flow]);

  const closing = closeFlow(flow.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const concurrent = { ...flow, id: "flow-concurrent", state: "waiting_ready", rounds: [], closedAt: null } as typeof flow;
  const duringTeardown = loadFlows();
  duringTeardown.find((item) => item.id === flow.id)!.rounds.at(-1)!.reviewerBindingId = "replacement-close-binding";
  saveFlows([...duringTeardown, concurrent]);

  expect(await closing).toEqual({ error: "flow changed during reviewer teardown", status: 409 });
  expect(loadFlows().map((item) => item.id).sort()).toEqual([flow.id, concurrent.id].sort());
  expect(loadFlows().find((item) => item.id === flow.id)).toMatchObject({
    state: "reviewing",
    rounds: [{ n: round.n, reviewerBindingId: "replacement-close-binding", error: null }],
  });
});

test("cancelRound rejects a replacement reviewer binding while preserving concurrent flows", async () => {
  saveFlows([]);
  const executablePath = path.join(sandbox, "delayed-reviewer-cancel");
  fs.writeFileSync(executablePath, `#!${process.execPath}\nprocess.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));\nsetInterval(() => {}, 1_000);\n`, { mode: 0o700 });
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);
  const created = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);
  const flow = created.flow!;
  const round = newRound(flow, "button", null);
  flow.rounds.push(round);
  flow.state = "reviewing";
  const launched = startHeadlessReview(flow.id, round.n, flow.roles.reviewer, sandbox, "review", 5_000, null, null, { command: executablePath });
  round.reviewerPid = launched.pid;
  round.reviewerIdentity = launched.identity;
  saveFlows([flow]);

  const cancelling = cancelRound(flow.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const concurrent = { ...flow, id: "flow-concurrent-cancel", state: "waiting_ready", rounds: [], closedAt: null } as typeof flow;
  const duringTeardown = loadFlows();
  duringTeardown.find((item) => item.id === flow.id)!.rounds.at(-1)!.reviewerBindingId = "replacement-cancel-binding";
  saveFlows([...duringTeardown, concurrent]);

  expect(await cancelling).toEqual({ error: "flow changed during reviewer teardown", status: 409 });
  expect(loadFlows().map((item) => item.id).sort()).toEqual([flow.id, concurrent.id].sort());
  expect(loadFlows().find((item) => item.id === flow.id)).toMatchObject({
    state: "reviewing",
    rounds: [{ n: round.n, reviewerBindingId: "replacement-cancel-binding", error: null }],
  });
});

test("malformed target SHAs return 400 without persisting a flow (#522)", async () => {
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);
  const request = {
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex" as const, model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex" as const, model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head" as const,
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto" as const,
    reviewerMode: "headless" as const,
    roundLimit: 5,
  };

  for (const targetSha of [null, 7, { sha: "a".repeat(40) }]) {
    saveFlows([]);
    const result = await createFlowFromRequest({ ...request, targetSha } as never, []);
    expect(result).toEqual({ error: "targetSha must be an exact commit SHA", status: 400 });
    expect(loadFlows()).toEqual([]);
  }
});

test("issue 1065: advance rescues a flow wedged in fixing on an uncorroborated structured relay", async () => {
  saveFlows([]);
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);
  const created = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);
  const flow = created.flow!;
  /* The wedged state the incident left behind: the relay claimed settlement the
     delivery journal never recorded, so the implementer never got the verdict
     and the flow waits in `fixing` for a REVIEW_READY that cannot come. */
  flow.rounds.push({
    ...newRound(flow, "marker", null),
    findingsPath: path.join(sandbox, "wedged-findings.md"),
    verdict: "REQUEST_CHANGES",
    findingsCount: 1,
    reviewedAt: "2026-08-20T16:47:51.534Z",
    terminalAt: "2026-08-20T16:47:51.534Z",
    relayStartedAt: "2026-08-20T16:47:51.534Z",
    relayDeliveryTransport: "structured",
    relayDelivery: { path: transcript, deliveredAt: "2026-08-20T16:47:52.921Z" },
    relayedAt: "2026-08-20T16:47:52.921Z",
  });
  flow.state = "fixing";
  saveFlows([flow]);

  const advanced = patchFlow(flow.id, { action: "advance" });

  expect(advanced.error).toBeUndefined();
  expect(loadFlows()[0]).toMatchObject({
    state: "relaying",
    rounds: [{
      relayDelivery: null,
      relayedAt: null,
      relayPendingSettlement: null,
      relayStartedAt: null,
      relayRetryCount: 0,
      relayRetryAt: null,
      /* The re-send reuses the durable identity, so a late delivery dedupes. */
      relayRetryRequiresIdempotency: true,
      error: null,
    }],
  });
});

test("issue 1065: advance still refuses a fixing flow whose relay the delivery journal corroborated", async () => {
  saveFlows([]);
  const transcript = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const implementer = registry.ensureConversation("codex", transcript, null);
  const created = await createFlowFromRequest({
    implementerPath: transcript,
    implementerConversationId: implementer.id,
    deliverKickoff: false,
    roles: {
      implementer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    },
    baseMode: "head",
    baseRef: "12ad73656844d3583d44ae718d003c7f2f2c6ace",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
  }, []);
  const flow = created.flow!;
  flow.rounds.push({
    ...newRound(flow, "marker", null),
    findingsPath: path.join(sandbox, "settled-findings.md"),
    verdict: "REQUEST_CHANGES",
    findingsCount: 1,
    reviewedAt: "2026-08-20T16:47:51.534Z",
    terminalAt: "2026-08-20T16:47:51.534Z",
    relayStartedAt: "2026-08-20T16:47:51.534Z",
    relayDeliveryTransport: "structured",
    relayDelivery: { path: transcript, deliveredAt: "2026-08-20T16:47:52.921Z" },
    relayedAt: "2026-08-20T16:47:52.921Z",
  });
  flow.state = "fixing";
  const held = registry.holdDelivery(implementer.id, "relayed findings", relayClientMessageId(flow));
  registry.recordDeliveryOutcome(held.id, "delivered");
  saveFlows([flow]);

  expect(patchFlow(flow.id, { action: "advance" }))
    .toEqual({ error: "flow cannot advance from its current state", status: 409 });
  expect(loadFlows()[0]).toMatchObject({ state: "fixing", rounds: [{ relayedAt: "2026-08-20T16:47:52.921Z" }] });
});
