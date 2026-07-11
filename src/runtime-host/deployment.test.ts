import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ViewerHealthEvidence, ViewerReleaseIdentity } from "@/lib/runtime/contracts";
import { runtimeHostClient, UnixRuntimeHostClient } from "@/lib/runtime/client";

import { ViewerDeploymentCoordinator, type ViewerDeploymentAdapter } from "./deployment";
import { viewerCandidateDockerArgs } from "./candidateContainer";
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
  resolveGate: Promise<void> | null = null;
  resolveFailures = 0;
  buildGate: Promise<void> | null = null;
  candidateHealth = healthy("http://127.0.0.1/candidate");
  promotedHealth = healthy("http://127.0.0.1:8898");
  calls: string[] = [];

  async reconcile(): Promise<void> { this.calls.push("reconcile"); }
  async resolveRevision(revision: string): Promise<string> {
    this.calls.push(`resolve:${revision}`);
    await this.resolveGate;
    if (this.resolveFailures > 0) { this.resolveFailures -= 1; throw new Error("revision resolution timed out"); }
    return revision === "origin/main" ? "a".repeat(40) : revision;
  }
  async buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
    this.calls.push(`build:${revision}`);
    await this.buildGate;
    return release(revision, deploymentId);
  }
  async startCandidate(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`start:${candidate.container}`); }
  async currentRelease(): Promise<ViewerReleaseIdentity | null> { this.calls.push("current"); return this.current; }
  async verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> { this.calls.push(`verify-candidate:${candidate.container}`); return this.candidateHealth; }
  async promote(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`promote:${candidate.container}`); this.current = candidate; }
  async verifyPromoted(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> { this.calls.push(`verify-promoted:${candidate.container}`); return this.promotedHealth; }
  async rollback(previous: ViewerReleaseIdentity, candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`rollback:${candidate.container}`); this.current = previous; }
  async retire(candidate: ViewerReleaseIdentity): Promise<void> { this.calls.push(`retire:${candidate.container}`); }
  async retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> { this.calls.push(`retain-only:${releases.map((item) => item.container).join(",")}`); }
}

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
  adapter.candidateHealth = { ...healthy("http://127.0.0.1/candidate"), ok: false, assets: [{ path: "/_next/static/app.js", status: 404 }], detail: "asset gate failed" };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "unhealthy" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "failed", terminal: true, error: "asset gate failed" });
  expect(status?.health[0]?.assets).toEqual([{ path: "/_next/static/app.js", status: 404 }]);
  expect(adapter.current).toEqual(previous);
  expect(adapter.calls.some((call) => call.startsWith("promote:"))).toBe(false);
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  store.close();
});

test("a post-promotion failure restores the previous healthy release", async () => {
  const store = journal("rollback");
  const adapter = new FakeDeploymentAdapter();
  const previous = adapter.current;
  adapter.promotedHealth = { ...healthy("http://127.0.0.1:8898"), ok: false, rootStatus: 503, detail: "stable listener failed" };
  const coordinator = new ViewerDeploymentCoordinator(store, adapter, { pid: 10, startIdentity: "10:1" });

  const receipt = await coordinator.requestViewerDeployment({ idempotencyKey: "rollback" });
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const status = await coordinator.waitForDeployment(receipt.deploymentId);

  expect(status).toMatchObject({ phase: "rolled-back", terminal: true, previous });
  expect(adapter.current).toEqual(previous);
  expect(adapter.calls.findIndex((call) => call.startsWith("promote:"))).toBeLessThan(adapter.calls.findIndex((call) => call.startsWith("rollback:")));
  expect(adapter.calls).toContain(`retire:${status?.candidate?.container}`);
  expect(status?.health).toHaveLength(2);
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

test("restart recovery finishes rollback from a journaled promotion phase", async () => {
  const filename = journalFile("promotion-recovery");
  const beforeRestart = new RuntimeJournal(filename, { now: () => 1_000 });
  const receipt = beforeRestart.admitViewerDeployment(
    { idempotencyKey: "recover-promotion", requestedRevision: "origin/main", revision: "c".repeat(40) },
    { pid: 91, startIdentity: "91:old" },
  );
  if (receipt.state !== "accepted") throw new Error("deployment was not accepted");
  const previous = release("old", "old");
  const candidate = release("c".repeat(40), receipt.deploymentId);
  beforeRestart.updateViewerDeployment(receipt.deploymentId, { phase: "promoting", previous, candidate, health: [healthy(candidate.endpoint)] });
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
  const args = viewerCandidateDockerArgs(release("current", "current"), {
    uid: "1000", gid: "1000", envFile: "/config/service.env", envFileExists: false, runtimeSocket: socketPath,
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
