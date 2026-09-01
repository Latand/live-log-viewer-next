import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ViewerDeploymentStatus,
  ViewerHealthEvidence,
  ViewerMcpRuntimeIdentity,
  ViewerMcpRuntimePublicationEvidence,
  ViewerMcpRuntimeReconciliation,
  ViewerReleaseIdentity,
  ViewerRuntimeHostHandoffEvidence,
  ViewerRuntimeHostStartupPhase,
} from "@/lib/runtime/contracts";
import { runtimeHostClient, UnixRuntimeHostClient } from "@/lib/runtime/client";

import { ViewerDeploymentCoordinator, type ViewerDeploymentAdapter } from "./deployment";
import { viewerCandidateDockerArgs, viewerComposeServiceFromConfig } from "./candidateContainer";
import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { serveRuntimeHost } from "./socket";

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function journal(name: string): RuntimeJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llv-deploy-${name}-`));
  sandboxes.push(dir);
  return new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
}

function journalFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llv-deploy-${name}-`));
  sandboxes.push(dir);
  return path.join(dir, "runtime.sqlite");
}

function release(revision: string, label: string): ViewerReleaseIdentity {
  return { revision, image: `viewer:${revision}`, container: `viewer-${label}`, endpoint: `http://127.0.0.1/${label}` };
}

function healthy(endpoint: string): ViewerHealthEvidence {
  return {
    checkedAt: "2026-07-11T12:00:00.000Z",
    endpoint,
    processReady: true,
    rootStatus: 200,
    authenticatedStatus: 200,
    unauthorizedStatus: 403,
    assets: [{ path: "/_next/static/app.js", status: 200 }, { path: "/_next/static/app.css", status: 200 }],
    ok: true,
  };
}

class FakeDeploymentAdapter implements ViewerDeploymentAdapter {
  current = release("old", "old");
  currentMcp: ViewerMcpRuntimeIdentity = {
    source: "legacy" as const,
    revision: "8".repeat(40),
    releaseId: null,
    artifactDigest: "8".repeat(64),
    stagedAt: null,
  };
  resolveGate: Promise<void> | null = null;
  resolveFailures = 0;
  buildGate: Promise<void> | null = null;
  candidateHealth = healthy("http://127.0.0.1/candidate");
  promotedHealth = healthy("http://127.0.0.1:8898");
  stageHostFailure: Error | null = null;
  verifyHostFailure: Error | null = null;
  promoteFailure: Error | null = null;
  hotStateHandOver: string | null = null;
  calls: string[] = [];

  async reconcile(): Promise<void> { this.calls.push("reconcile"); }
  async verifyRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<ViewerRuntimeHostHandoffEvidence> {
    this.calls.push(`verify-host-successor:${candidate.image}:${candidate.revision}`);
    if (this.verifyHostFailure) throw this.verifyHostFailure;
    const generation = {
      image: candidate.image,
      revision: candidate.revision,
      container: `runtime-host-${candidate.revision.slice(0, 12)}`,
    };
    const identity = { generation, pid: 4242, startIdentity: "4242:successor", hostEpoch: 7 };
    const phases: ViewerRuntimeHostStartupPhase[] = [
      "fence-waiting",
      "fence-acquired",
      "journal-open",
      "handoff-cleanup-complete",
      "consumers-recovered",
      "socket-listening",
      "ready",
    ];
    return {
      ...identity,
      phases: phases.map((phase, index) => ({ ...identity, phase, recordedAt: `2026-08-31T14:00:0${index}.000Z` })),
      probe: {
        checkedAt: "2026-08-31T14:00:08.000Z",
        requestId: "runtime-host-health-probe",
        responseId: "runtime-host-health-probe",
        elapsedMs: 12,
      },
    };
  }
  async stageRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<void> {
    this.calls.push(`stage-host-successor:${candidate.image}:${candidate.revision}`);
    if (this.stageHostFailure) throw this.stageHostFailure;
  }
  async resolveRevision(revision: string): Promise<string> {
    this.calls.push(`resolve:${revision}`);
    await this.resolveGate;
    if (this.resolveFailures > 0) { this.resolveFailures -= 1; throw new Error("revision resolution timed out"); }
    return revision === "origin/main" || revision.startsWith("refs/heads/") ? "a".repeat(40) : revision;
  }
  async buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
    this.calls.push(`build:${revision}`);
    await this.buildGate;
    return {
      ...release(revision, deploymentId),
      mcpRuntime: {
        source: "managed",
        revision,
        releaseId: `deploy-${deploymentId}`,
        artifactDigest: "7".repeat(64),
        stagedAt: "2026-07-23T08:00:00.000Z",
      },
    };
  }
  async startCandidate(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`start:${candidate.container}`); }
  async currentRelease(): Promise<ViewerReleaseIdentity | null> { this.calls.push("current"); return this.current; }
  async verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> { this.calls.push(`verify-candidate:${candidate.container}`); return this.candidateHealth; }
  async currentMcpRuntime() { this.calls.push("current-mcp"); return this.currentMcp; }
  async reconcileMcpRuntime(revision: string): Promise<ViewerMcpRuntimeReconciliation> {
    this.calls.push(`reconcile-mcp-runtime:${revision}`);
    return {
      publication: {
        action: "activate",
        source: "managed",
        revision,
        releaseId: "deploy-reconciled",
        artifactDigest: "9".repeat(64),
        stagedAt: "2026-07-23T08:00:03.000Z",
        publishedAt: "2026-07-23T08:00:04.000Z",
        durable: true,
      },
      health: {
        checkedAt: "2026-07-23T08:00:05.000Z",
        revision,
        artifactDigest: "9".repeat(64),
        processReady: true,
        tools: ["deployment_status", "board_snapshot"],
        calls: { deploymentStatus: true, boardSnapshot: true },
        ok: true,
      },
    };
  }
  async promote(candidate: ViewerReleaseIdentity): Promise<ViewerMcpRuntimePublicationEvidence> {
    this.calls.push(`promote:${candidate.container}`);
    if (this.promoteFailure) throw this.promoteFailure;
    this.current = candidate;
    this.currentMcp = candidate.mcpRuntime!;
    return {
      action: "activate",
      ...candidate.mcpRuntime!,
      publishedAt: "2026-07-23T08:00:01.000Z",
      durable: true,
      ...(this.hotStateHandOver ? { hotStateHandOver: this.hotStateHandOver } : {}),
    };
  }
  async verifyPromoted(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> { this.calls.push(`verify-promoted:${candidate.container}`); return this.promotedHealth; }
  async rollback(previous: ViewerReleaseIdentity, candidate: ViewerReleaseIdentity): Promise<ViewerMcpRuntimePublicationEvidence> {
    this.calls.push(`rollback:${candidate.container}`);
    this.current = previous;
    this.currentMcp = previous.mcpRuntime ?? {
      source: "legacy",
      revision: "8".repeat(40),
      releaseId: null,
      artifactDigest: "8".repeat(64),
      stagedAt: null,
    };
    return {
      action: "restore",
      ...this.currentMcp,
      publishedAt: "2026-07-23T08:00:02.000Z",
      durable: true,
    };
  }
  async retire(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`retire:${candidate.container}`); }
  async retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> { this.calls.push(`retain-only:${releases.map((item) => item.container).join(",")}`); }
}

async function recoverHostHandoffAsSuccessor(
  store: RuntimeJournal,
  adapter: FakeDeploymentAdapter,
  deploymentId: string,
  candidate: ViewerReleaseIdentity,
  owner: { pid: number; startIdentity: string },
) {
  const successor = new ViewerDeploymentCoordinator(store, adapter, owner, {
    ownerAlive: () => false,
    hostGeneration: () => ({ image: candidate.image, revision: candidate.revision }),
  });
  await successor.recover();
  return successor.waitForDeployment(deploymentId);
}

/* These cover admission, idempotency, ownership and health. Deploy authority
   lives with the designated agent at the MCP deploy binding (#795); admission
   takes any well-formed request from the local surfaces that reach it. */

test("deployment admission is serialized and idempotent", async () => {
  const store = journal("admission");
  const adapter = new FakeDeploymentAdapter();
  let releaseBuild!: () => void;
  adapter.buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const first = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-one" });
  const replay = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-one" });
  const busy = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-two" });

  expect(first).toMatchObject({ state: "accepted", replayed: false, revision: "a".repeat(40) });
  if (first.state !== "accepted") throw new Error("deployment was not accepted");
  expect(replay).toEqual({ ...first, replayed: true });
  expect(busy).toEqual({ state: "busy", deploymentId: first.deploymentId, revision: "a".repeat(40) });
  expect(adapter.calls.filter((call) => call.startsWith("resolve:"))).toEqual(["resolve:origin/main"]);
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);

  releaseBuild();
  await coordinator.waitForDeployment(first.deploymentId);
  expect(adapter.calls.some((call) => call.startsWith("retain-only:"))).toBe(true);
  store.close();
});

test("issue 1033: a branch ref is resolved by the host and the ledger records the exact commit", async () => {
  const store = journal("ref-admission");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ ref: "refs/heads/main", idempotencyKey: "deploy-ref" });

  expect(receipt).toMatchObject({ state: "accepted", revision: "a".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  expect(adapter.calls.filter((call) => call.startsWith("resolve:"))).toEqual(["resolve:refs/heads/main"]);
  await coordinator.waitForDeployment(receipt.deploymentId);
  /* The exactness the ledger keeps is the RESOLVED commit; the ref is kept
     beside it as what the caller asked for. */
  expect(coordinator.readViewerDeployment(receipt.deploymentId)).toMatchObject({
    requestedRevision: "refs/heads/main",
    revision: "a".repeat(40),
    phase: "succeeded",
    candidate: { revision: "a".repeat(40) },
  });
  store.close();
});

test("issue 1033: a ref outside the canonical repository's branches is refused before resolution", async () => {
  const store = journal("ref-refusal");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  await expect(coordinator.requestViewerDeployment({ ref: "refs/tags/v1", idempotencyKey: "deploy-tag" }))
    .rejects.toThrow("deployment revision must be origin/main, a canonical branch ref, or a full commit SHA");

  expect(adapter.calls).toEqual([]);
  store.close();
});

test("genuinely concurrent requests serialize revision resolution and return busy", async () => {
  const store = journal("concurrent-admission");
  const adapter = new FakeDeploymentAdapter();
  let releaseResolve!: () => void;
  adapter.resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const firstPromise = coordinator.requestViewerDeployment({ idempotencyKey: "concurrent-one" });
  await Promise.resolve();
  const secondPromise = coordinator.requestViewerDeployment({ idempotencyKey: "concurrent-two" });
  await Promise.resolve();

  expect(adapter.calls.filter((call) => call.startsWith("resolve:"))).toEqual(["resolve:origin/main"]);
  releaseResolve();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  if (first.state !== "accepted") throw new Error("first deployment was not accepted");
  expect(second).toEqual({ state: "busy", deploymentId: first.deploymentId, revision: first.revision });
  await coordinator.waitForDeployment(first.deploymentId);
  store.close();
});

test("failed revision resolution releases admission for a deterministic retry", async () => {
  const store = journal("admission-timeout");
  const adapter = new FakeDeploymentAdapter();
  adapter.resolveFailures = 1;
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  await expect(coordinator.requestViewerDeployment({ idempotencyKey: "timed-out" })).rejects.toThrow("timed out");
  const retry = await coordinator.requestViewerDeployment({ idempotencyKey: "retry-after-timeout" });

  expect(retry).toMatchObject({ state: "accepted", replayed: false });
  if (retry.state === "accepted") await coordinator.waitForDeployment(retry.deploymentId);
  store.close();
});

test("an unhealthy candidate leaves the serving release unchanged", async () => {
  const store = journal("candidate-gate");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  const previousMcpRuntime = adapter.currentMcp;
  adapter.candidateHealth = { ...healthy("http://127.0.0.1/candidate"), ok: false, assets: [{ path: "/_next/static/app.js", status: 404 }], detail: "asset gate failed" };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "unhealthy" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "failed", terminal: true, error: "asset gate failed" });
  expect(status?.health[0]?.assets).toEqual([{ path: "/_next/static/app.js", status: 404 }]);
  expect(adapter.current).toEqual(previous);
  expect(adapter.currentMcp).toEqual(previousMcpRuntime);
  expect(adapter.calls.some((call) => call.startsWith("promote:"))).toBe(false);
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(status?.mcpRuntime).toMatchObject({
    candidate: { source: "managed", revision: "a".repeat(40) },
    previous: null,
    publications: [],
  });
  store.close();
});

test("deployment status exposes exact MCP runtime staging and atomic publication evidence", async () => {
  const store = journal("mcp-publication-status");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const revision = "7".repeat(40);

  const receipt = await coordinator.requestViewerDeployment({
    idempotencyKey: "mcp-publication-status",
    revision,
  });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({
    phase: "succeeded",
    terminal: true,
    mcpRuntime: {
      candidate: {
        source: "managed",
        revision,
        artifactDigest: "7".repeat(64),
      },
      previous: {
        source: "legacy",
        revision: "8".repeat(40),
        artifactDigest: "8".repeat(64),
      },
      publications: [{
        action: "activate",
        source: "managed",
        revision,
        artifactDigest: "7".repeat(64),
        durable: true,
      }],
    },
  });
  expect(adapter.calls.findIndex((call) => call === "current-mcp"))
    .toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("promote:")));
  store.close();
});

test("a successor records first-boot MCP publication on the old terminal deployment receipt", async () => {
  const store = journal("mcp-successor-reconciliation");
  const adapter = new FakeDeploymentAdapter();
  const revision = "7".repeat(40);
  const receipt = store.admitViewerDeployment(
    { idempotencyKey: "old-adapter-deployment", requestedRevision: revision, revision },
    { pid: 9, startIdentity: "9:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  store.updateViewerDeployment(receipt.deploymentId, {
    phase: "succeeded",
    terminal: true,
    candidate: release(revision, "old-adapter-candidate"),
    previous: release("8".repeat(40), "previous"),
    /* The shape the predecessor generation journaled, before MCP health
       evidence had a home on the receipt. */
    mcpRuntime: { candidate: null, previous: null, publications: [] } as unknown as ViewerDeploymentStatus["mcpRuntime"],
  });
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:new" });
  const reconciliation = await adapter.reconcileMcpRuntime(revision);

  const updated = coordinator.recordMcpRuntimeReconciliation(reconciliation);

  expect(updated).toMatchObject({
    phase: "succeeded",
    terminal: true,
    candidate: {
      mcpRuntime: {
        source: "managed",
        revision,
        artifactDigest: "9".repeat(64),
      },
    },
    mcpRuntime: {
      candidate: {
        source: "managed",
        revision,
        artifactDigest: "9".repeat(64),
      },
      publications: [{
        action: "activate",
        revision,
        artifactDigest: "9".repeat(64),
        durable: true,
      }],
      health: [{
        revision,
        artifactDigest: "9".repeat(64),
        ok: true,
      }],
    },
  });
  store.close();
});

test("a post-promotion failure restores the previous healthy release", async () => {
  const store = journal("rollback");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  const previousMcpRuntime = adapter.currentMcp;
  adapter.promotedHealth = { ...healthy("http://127.0.0.1:8898"), ok: false, rootStatus: 503, detail: "stable listener failed" };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "rollback" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "rolled-back", terminal: true, previous });
  expect(adapter.current).toEqual(previous);
  expect(adapter.currentMcp).toEqual(previousMcpRuntime);
  expect(status?.mcpRuntime.publications).toMatchObject([
    { action: "activate", source: "managed", revision: "a".repeat(40), durable: true },
    { action: "restore", ...previousMcpRuntime, durable: true },
  ]);
  expect(adapter.calls.findIndex((call) => call.startsWith("promote:"))).toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("rollback:")));
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(status?.health).toHaveLength(2);
  store.close();
});

/* Production #518: the runtime-host container runs a baked image and its Bun
   process loads modules once at boot. PID 3970 kept executing a stale image
   (no #389 broker guard), so promptless Claude resume adoption kept failing
   with "message content is required" for hours after the fixed revision was
   deployed. /app is not live-mounted, so a same-image restart would boot the
   identical stale generation — the exact-SHA contract must instead stage the
   freshly built candidate image as the successor runtime-host generation. */
test("issue 1268: the predecessor leaves success non-terminal until the staged runtime-host successor takes over", async () => {
  const store = journal("host-successor");
  const adapter = new FakeDeploymentAdapter();
  const handoffs: Array<Record<string, unknown>> = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => {
      handoffs.push({
        ...context,
        terminalAtHandoff: store.viewerDeployment(context.deploymentId)?.terminal ?? null,
        stagedBeforeHandoff: adapter.calls.some((call) => call.startsWith("stage-host-successor:")),
      });
    },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-successor", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  const handedOff = store.viewerDeployment(receipt.deploymentId);
  expect(handedOff).toMatchObject({ phase: "host-handoff", terminal: false });
  /* The staged runtime-host generation IS the deployed candidate: its image
     and revision equal the promoted exact SHA, so the next host boot cannot
     resurrect the stale image. */
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:")))
    .toEqual([`stage-host-successor:${handedOff?.candidate?.image}:${"b".repeat(40)}`]);
  /* Durable ordering: the successor staging lands before the handoff signal,
     while terminal success remains unavailable to the predecessor. */
  expect(handoffs).toEqual([{
    deploymentId: receipt.deploymentId,
    revision: "b".repeat(40),
    successor: handedOff?.candidate,
    previous: { image: "agent-log-viewer:node22", revision: null },
    terminalAtHandoff: false,
    stagedBeforeHandoff: true,
  }]);
  /* The handoff never tears down promoted releases: engine hosts owned by
     Viewer processes keep running through the runtime-host replacement. */
  expect(adapter.calls.filter((call) => call.startsWith("rollback:"))).toEqual([]);
  expect(adapter.calls.filter((call) => call.startsWith("retire:"))).toEqual([]);

  const successor = new ViewerDeploymentCoordinator(
    store,
    adapter,
    { pid: 11, startIdentity: "11:2" },
    {
      ownerAlive: () => false,
      hostGeneration: () => ({ image: handedOff?.candidate?.image ?? null, revision: handedOff?.candidate?.revision ?? null }),
    },
  );
  await successor.recover();
  const completed = await successor.waitForDeployment(receipt.deploymentId);

  expect(completed).toMatchObject({
    phase: "succeeded",
    terminal: true,
    owner: { pid: 11, startIdentity: "11:2" },
    runtimeHostHandoff: {
      generation: {
        image: handedOff?.candidate?.image,
        revision: handedOff?.candidate?.revision,
      },
      phases: [{ phase: "fence-waiting" }, { phase: "fence-acquired" }, { phase: "journal-open" },
        { phase: "handoff-cleanup-complete" }, { phase: "consumers-recovered" }, { phase: "socket-listening" },
        { phase: "ready" }],
      probe: { requestId: "runtime-host-health-probe", responseId: "runtime-host-health-probe" },
    },
  });
  expect(adapter.calls).toContain(
    `verify-host-successor:${handedOff?.candidate?.image}:${handedOff?.candidate?.revision}`,
  );
  store.close();
});

test("issue 1268: terminal success requires runtime-host hand-off evidence even when generation tracking is unavailable", async () => {
  const store = journal("host-successor-proof-required");
  const adapter = new FakeDeploymentAdapter();
  adapter.verifyHostFailure = new Error("runtime-host startup evidence is unavailable");
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({
    idempotencyKey: "deploy-host-successor-proof-required",
    revision: "b".repeat(40),
  });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({
    phase: "host-handoff",
    terminal: false,
    error: "runtime-host startup evidence is unavailable",
  });
  expect(adapter.calls).toContain(
    `verify-host-successor:${store.viewerDeployment(receipt.deploymentId)?.candidate?.image}:${"b".repeat(40)}`,
  );
  store.close();
});

/* #1216 reopened. The promote fix could not be delivered by the mechanism it
   fixes, and this is the ordering that makes that true: runtime-host
   succession lives in the `host-handoff` phase, which is downstream of
   `promoting`. A promote that times out rolls back and never reaches it, so
   the runtime host keeps executing the old promote path on the next attempt,
   and the next, and the next. `scripts/bootstrap-runtime-host.ts` exists
   because of this test. */
test("issue 1216: a promote that times out never reaches runtime-host successor staging", async () => {
  const store = journal("promote-timeout-host");
  const adapter = new FakeDeploymentAdapter();
  adapter.promoteFailure = new Error("deployment adapter promote timed out while waiting for hot-state activation");
  const handoffs: string[] = [];
  const lines: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
    log: (line) => { lines.push(line); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "promote-timeout", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({
    phase: "rolled-back",
    terminal: true,
    error: "deployment adapter promote timed out while waiting for hot-state activation",
  });
  /* The runtime host is left on whatever generation it was already running:
     the deployment that carried the promote repair never staged a successor
     that could execute it. */
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(handoffs).toEqual([]);
  expect(lines.some((line) => line.includes("host-handoff"))).toBe(false);
  store.close();
});

/* Three deployments in a row left an operator unable to answer "did this even
   try to replace the runtime host?" from the log. The step now says what it
   decided and why. */
test("issue 1216: the host-handoff step narrates the decision it made", async () => {
  const store = journal("host-handoff-log");
  const adapter = new FakeDeploymentAdapter();
  adapter.hotStateHandOver = "incumbent released hot state after 4s; activation published after 12s";
  const lines: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    log: (line) => { lines.push(line); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "host-handoff-log", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  const image = store.viewerDeployment(receipt.deploymentId)?.candidate?.image;
  expect(lines).toEqual([
    `[viewer deployment] ${receipt.deploymentId} promote hot-state hand-over: incumbent released hot state after 4s; activation published after 12s`,
    `[viewer deployment] ${receipt.deploymentId} host-handoff staging a successor for ${"b".repeat(40)}; the running generation is untracked`,
    `[viewer deployment] ${receipt.deploymentId} host-handoff staged; the successor waits for the singleton fence while this generation hands off ${"b".repeat(40)}`,
  ]);
  expect(image).toBe(`viewer:${"b".repeat(40)}`);
  store.close();
});

/* A staging failure parks the deployment in a retryable `host-handoff` phase
   and returns normally, so nothing printed it: the host stayed on the old
   generation with no line in the log to say so. */
test("issue 1216: a failed successor staging is printed, not only journalled", async () => {
  const store = journal("host-handoff-failure-log");
  const adapter = new FakeDeploymentAdapter();
  adapter.stageHostFailure = new Error("runtime-host predecessor container is unavailable for successor staging");
  const lines: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    log: (line) => { lines.push(line); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "host-handoff-failure", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({ phase: "host-handoff", terminal: false });
  expect(lines).toContain(
    `[viewer deployment] ${receipt.deploymentId} host-handoff failed and stays retryable: runtime-host predecessor container is unavailable for successor staging`,
  );
  store.close();
});

test("issue 518: a runtime host already on the deployed generation stages no successor", async () => {
  const store = journal("host-current");
  const adapter = new FakeDeploymentAdapter();
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: `viewer:${"b".repeat(40)}`, revision: "b".repeat(40) }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-current", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({ phase: "succeeded", terminal: true });
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(handoffs).toEqual([]);
  store.close();
});

test("issue 521 review: consecutive same-revision deployments stage each distinct candidate image", async () => {
  const store = journal("host-same-revision-image");
  const adapter = new FakeDeploymentAdapter();
  adapter.buildCandidate = async (deploymentId, candidateRevision) => {
    adapter.calls.push(`build:${candidateRevision}`);
    return {
      ...release(candidateRevision, deploymentId),
      image: `viewer:${candidateRevision}:${deploymentId}`,
      mcpRuntime: {
        source: "managed",
        revision: candidateRevision,
        releaseId: `deploy-${deploymentId.replaceAll("_", "-")}`,
        artifactDigest: "7".repeat(64),
        stagedAt: "2026-07-23T08:00:00.000Z",
      },
    };
  };
  let running = { image: "agent-log-viewer:node22", revision: null as string | null };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => running,
    onHostHandoff: (context) => { running = { image: context.successor.image, revision: context.successor.revision }; },
  });
  const candidateRevision = "b".repeat(40);

  const first = await coordinator.requestViewerDeployment({ idempotencyKey: "same-revision-one", revision: candidateRevision });
  if (first.state !== "accepted") throw new Error("first deployment was not accepted");
  const firstHandoff = await coordinator.waitForDeployment(first.deploymentId);
  if (!firstHandoff?.candidate) throw new Error("first handoff candidate is missing");
  const firstStatus = await recoverHostHandoffAsSuccessor(
    store,
    adapter,
    first.deploymentId,
    firstHandoff.candidate,
    { pid: 11, startIdentity: "11:first" },
  );
  const second = await coordinator.requestViewerDeployment({ idempotencyKey: "same-revision-two", revision: candidateRevision });
  if (second.state !== "accepted") throw new Error("second deployment was not accepted");
  const secondHandoff = await coordinator.waitForDeployment(second.deploymentId);
  if (!secondHandoff?.candidate) throw new Error("second handoff candidate is missing");
  const secondStatus = await recoverHostHandoffAsSuccessor(
    store,
    adapter,
    second.deploymentId,
    secondHandoff.candidate,
    { pid: 12, startIdentity: "12:second" },
  );

  expect(firstStatus?.candidate?.image).not.toBe(secondStatus?.candidate?.image);
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([
    `stage-host-successor:${firstStatus?.candidate?.image}:${candidateRevision}`,
    `stage-host-successor:${secondStatus?.candidate?.image}:${candidateRevision}`,
  ]);
  store.close();
});

test("issue 518: failed successor staging never hands the host back to the stale image", async () => {
  const store = journal("host-staging-failed");
  const adapter = new FakeDeploymentAdapter();
  adapter.stageHostFailure = new Error("docker tag failed");
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-staging-failed", revision: "b".repeat(40) });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  /* The healthy Viewer remains promoted while the deployment stays in its
     durable retry phase. A replay resumes successor staging from that phase
     without rebuilding or promoting another candidate. */
  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({
    phase: "host-handoff",
    terminal: false,
    error: "docker tag failed",
  });
  expect(handoffs).toEqual([]);
  const buildCalls = adapter.calls.filter((call) => call.startsWith("build:"));
  adapter.stageHostFailure = null;
  const replay = await coordinator.requestViewerDeployment({
    idempotencyKey: "deploy-host-staging-failed",
    revision: "b".repeat(40),
  });
  expect(replay).toMatchObject({ state: "accepted", replayed: true, deploymentId: receipt.deploymentId });
  const handedOff = await coordinator.waitForDeployment(receipt.deploymentId);
  if (!handedOff?.candidate) throw new Error("handoff candidate is missing");
  await recoverHostHandoffAsSuccessor(
    store,
    adapter,
    receipt.deploymentId,
    handedOff.candidate,
    { pid: 11, startIdentity: "11:recovery" },
  );

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({ phase: "succeeded", terminal: true, error: null });
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toEqual(buildCalls);
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toHaveLength(2);
  expect(handoffs).toEqual([receipt.deploymentId]);
  store.close();
});

test("issue 518: a failed candidate never stages a runtime-host successor", async () => {
  const store = journal("host-failed-candidate");
  const adapter = new FakeDeploymentAdapter();
  adapter.candidateHealth = { ...healthy("http://127.0.0.1/candidate"), ok: false, detail: "candidate health gate failed" };
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" }, {
    hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
    onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
  });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "deploy-host-failed-candidate" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);

  expect(store.viewerDeployment(receipt.deploymentId)).toMatchObject({ phase: "failed", terminal: true });
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:"))).toEqual([]);
  expect(handoffs).toEqual([]);
  store.close();
});

test("successful cleanup retains the serving and immediate rollback releases", async () => {
  const store = journal("release-retention");
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const first = await coordinator.requestViewerDeployment({ idempotencyKey: "retention-one", revision: "1".repeat(40) });
  if (first.state !== "accepted") throw new Error("deployment was not accepted");
  const firstStatus = await coordinator.waitForDeployment(first.deploymentId);
  const second = await coordinator.requestViewerDeployment({ idempotencyKey: "retention-two", revision: "2".repeat(40) });
  if (second.state !== "accepted") throw new Error("deployment was not accepted");
  const secondStatus = await coordinator.waitForDeployment(second.deploymentId);

  expect(adapter.calls.filter((call) => call.startsWith("retain-only:")).at(-1)).toBe(
    `retain-only:${secondStatus?.candidate?.container},${firstStatus?.candidate?.container}`,
  );
  store.close();
});

test("restart recovery reclaims a stale build lease and completes the deployment", async () => {
  const filename = journalFile("build-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-build", requestedRevision: "origin/main", revision: "b".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  beforeRestart.updateViewerDeployment(receipt.deploymentId, { phase: "building" });
  beforeRestart.close();

  const afterRestart = new RuntimeJournal(filename, { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  const coordinator = new ViewerDeploymentCoordinator(
    afterRestart,
    adapter,
    { pid: 92, startIdentity: "92:new" },
    { ownerAlive: () => false },
  );
  await coordinator.recover();
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "succeeded", terminal: true, owner: { pid: 92, startIdentity: "92:new" } });
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toEqual([`build:${"b".repeat(40)}`]);
  afterRestart.close();
});

test("issue 518: restart recovery resumes a durable host-handoff phase", async () => {
  const filename = journalFile("host-handoff-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-host-handoff", requestedRevision: "origin/main", revision: "b".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const previous = release("old", "old");
  const candidate = release("b".repeat(40), receipt.deploymentId);
  beforeRestart.updateViewerDeployment(receipt.deploymentId, {
    phase: "host-handoff",
    previous,
    candidate,
    health: [healthy(candidate.endpoint), healthy("http://127.0.0.1:8898")],
  });
  beforeRestart.close();

  const afterRestart = new RuntimeJournal(filename, { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  adapter.current = candidate;
  const handoffs: string[] = [];
  const coordinator = new ViewerDeploymentCoordinator(
    afterRestart,
    adapter,
    { pid: 92, startIdentity: "92:new" },
    {
      ownerAlive: () => false,
      hostGeneration: () => ({ image: "agent-log-viewer:node22", revision: null }),
      onHostHandoff: (context) => { handoffs.push(context.deploymentId); },
    },
  );

  await coordinator.recover();
  const handedOff = await coordinator.waitForDeployment(receipt.deploymentId);
  if (!handedOff?.candidate) throw new Error("handoff candidate is missing");
  const status = await recoverHostHandoffAsSuccessor(
    afterRestart,
    adapter,
    receipt.deploymentId,
    handedOff.candidate,
    { pid: 93, startIdentity: "93:successor" },
  );

  expect(status).toMatchObject({
    phase: "succeeded",
    terminal: true,
    owner: { pid: 93, startIdentity: "93:successor" },
  });
  expect(adapter.calls.filter((call) => call.startsWith("build:"))).toEqual([]);
  expect(adapter.calls.filter((call) => call.startsWith("promote:"))).toEqual([]);
  expect(adapter.calls.filter((call) => call.startsWith("stage-host-successor:")))
    .toEqual([`stage-host-successor:${candidate.image}:${candidate.revision}`]);
  expect(handoffs).toEqual([receipt.deploymentId]);
  afterRestart.close();
});

test("restart recovery finishes rollback from a journaled promotion phase", async () => {
  const filename = journalFile("promotion-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-promotion", requestedRevision: "origin/main", revision: "c".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const previous = release("old", "old");
  const candidate = {
    ...release("c".repeat(40), receipt.deploymentId),
    mcpRuntime: {
      source: "managed" as const,
      revision: "c".repeat(40),
      releaseId: `deploy-${receipt.deploymentId.replaceAll("_", "-")}`,
      artifactDigest: "c".repeat(64),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  };
  const previousMcpRuntime = {
    source: "legacy" as const,
    revision: "8".repeat(40),
    releaseId: null,
    artifactDigest: "8".repeat(64),
    stagedAt: null,
  };
  beforeRestart.updateViewerDeployment(receipt.deploymentId, {
    phase: "promoting",
    previous,
    candidate,
    health: [healthy(candidate.endpoint)],
    mcpRuntime: { candidate: candidate.mcpRuntime, previous: previousMcpRuntime, publications: [], health: [] },
  });
  beforeRestart.close();

  const afterRestart = new RuntimeJournal(filename, { now: () => 2_000 });
  const adapter = new FakeDeploymentAdapter();
  adapter.current = previous;
  adapter.promotedHealth = { ...healthy("http://127.0.0.1:8898"), ok: false, detail: "restart probe failed" };
  const coordinator = new ViewerDeploymentCoordinator(
    afterRestart,
    adapter,
    { pid: 92, startIdentity: "92:new" },
    { ownerAlive: () => false },
  );
  await coordinator.recover();
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "rolled-back", terminal: true });
  expect(adapter.current).toEqual(previous);
  expect(adapter.currentMcp).toEqual(previousMcpRuntime);
  expect(status?.mcpRuntime.publications).toMatchObject([
    { action: "activate", source: "managed", revision: candidate.revision, durable: true },
    { action: "restore", ...previousMcpRuntime, durable: true },
  ]);
  expect(adapter.calls).toContain(`promote:${candidate.container}`);
  expect(adapter.calls).toContain(`rollback:${candidate.container}`);
  afterRestart.close();
});

test("staged end-to-end build survives a host restart and a later release rolls back", async () => {
  const filename = journalFile("staged-e2e");
  const firstJournal = new RuntimeJournal(filename, { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  const firstCoordinator = new ViewerDeploymentCoordinator(firstJournal, adapter, { pid: 71, startIdentity: "71:first" });
  const first = await firstCoordinator.requestViewerDeployment({ idempotencyKey: "staged-first" });
  if (first.state !== "accepted") throw new Error("deployment was not accepted");
  expect((await firstCoordinator.waitForDeployment(first.deploymentId))?.phase).toBe("succeeded");
  const firstRelease = adapter.current;
  firstJournal.close();

  const restartedJournal = new RuntimeJournal(filename, { now: () => 2_000 });
  adapter.promotedHealth = { ...healthy(stableEndpointForTest()), ok: false, detail: "staged post-promotion failure" };
  const restartedCoordinator = new ViewerDeploymentCoordinator(restartedJournal, adapter, { pid: 72, startIdentity: "72:restarted" });
  expect(await restartedCoordinator.recover()).toBeNull();
  const second = await restartedCoordinator.requestViewerDeployment({ idempotencyKey: "staged-second", revision: "d".repeat(40) });
  if (second.state !== "accepted") throw new Error("deployment was not accepted");
  const secondStatus = await restartedCoordinator.waitForDeployment(second.deploymentId);

  expect(secondStatus?.phase).toBe("rolled-back");
  expect(adapter.current).toEqual(firstRelease);
  expect(secondStatus?.health.flatMap((item) => item.assets).every((asset) => asset.status === 200)).toBe(true);
  restartedJournal.close();
});

test("newly promoted Viewer environment requests the next deployment through runtime-host", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-socket-"));
  sandboxes.push(dir);
  const store = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
  const coordinator = new ViewerDeploymentCoordinator(store, new FakeDeploymentAdapter(), { pid: 10, startIdentity: "10:1" });
  const socketPath = path.join(dir, "runtime.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(store, undefined, coordinator));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const composeService = viewerComposeServiceFromConfig(JSON.stringify({ services: { viewer: {
    build: {}, command: null, entrypoint: null, environment: {}, image: "viewer:compose", network_mode: "host",
    pid: "host", privileged: true, restart: "unless-stopped", user: "1000:1000", volumes: [], working_dir: "/app",
  } } }));
  const args = viewerCandidateDockerArgs(release("current", "current"), composeService, {
    runtimeSocket: socketPath,
    legacyTmuxExternal: "1", tmuxTmpdir: "/run/user/1000/agent-log-viewer",
  });
  const environment = {} as NodeJS.ProcessEnv;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-e") continue;
    const [key, ...value] = args[index + 1]!.split("=");
    environment[key!] = value.join("=");
  }
  const client = runtimeHostClient(environment);
  if (!client) throw new Error("promoted Viewer runtime client is unavailable");

  const receipt = await client.requestViewerDeployment({ idempotencyKey: "socket-deploy" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  await coordinator.waitForDeployment(receipt.deploymentId);
  const status = await client.readViewerDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ deploymentId: receipt.deploymentId, phase: "succeeded", terminal: true });
  expect((await client.snapshot()).deployments).toHaveLength(1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
});

test("Viewer socket admission outlives the ordinary client timeout during delayed revision resolution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-socket-timeout-"));
  sandboxes.push(dir);
  const store = new RuntimeJournal(path.join(dir, "runtime.sqlite"), { now: () => 1_000 });
  const adapter = new FakeDeploymentAdapter();
  adapter.resolveGate = new Promise<void>((resolve) => setTimeout(resolve, 30));
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });
  const server = serveRuntimeHost(
    path.join(dir, "runtime.sock"),
    new RuntimeHost(store, undefined, coordinator),
    { defaultTimeoutMs: 10, deploymentTimeoutMs: 100 },
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(path.join(dir, "runtime.sock"), 10, 100);

  try {
    const receipt = await client.requestViewerDeployment({ idempotencyKey: "delayed-socket-deploy" });
    expect(receipt).toMatchObject({ state: "accepted", replayed: false });
    if (receipt.state === "accepted") await coordinator.waitForDeployment(receipt.deploymentId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

function stableEndpointForTest(): string {
  return "http://127.0.0.1:8898";
}
