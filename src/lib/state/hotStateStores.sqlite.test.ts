import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";

import { checkpointFlowRollbackMirrorForDemotion, loadFlows, saveFlows, withFlowMutation } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { procBackend } from "@/lib/proc";
import { buildPipeline, loadArchivedPipelines, loadPipelines } from "@/lib/pipelines/store";
import type { PipelineStage } from "@/lib/pipelines/types";
import { buildWorkflow, loadWorkflows, normalizeTemplate } from "@/lib/workflows/store";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";
import { hotStateMigrationDryRun } from "./hotStateMigration";
import {
  acknowledgeHotStateFence,
  HOT_STATE_BACKEND,
  HOT_STATE_RELEASE_REVISION_ENV,
  hotStateSqliteWriterReady,
  markHotStateActivationReady,
  markViewerReleaseReady,
  publishHotStateAuthority,
  readHotStateAuthority,
  restoreHotStateAuthority,
} from "./hotStateAuthority";
import { initializeStateCollections, readStateCollectionRows, SqliteStateCollection, stateLeaseOwnerAlive } from "./sqliteStateStore";

const CHILD = path.join(import.meta.dir, "hotStateStores.sqliteChild.ts");
const MIRROR_CHILD = path.join(import.meta.dir, "hotStateMirror.sqliteChild.ts");
const SNAPSHOT_CHILD = path.join(import.meta.dir, "hotStateSnapshot.sqliteChild.ts");
const AUTHORITY_CHILD = path.join(import.meta.dir, "hotStateAuthority.sqliteChild.ts");

function sampleFlow(id: string, stateDetail: string | null = null): Flow {
  return {
    id,
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: `/${id}.jsonl`,
    roles: {
      implementer: { engine: "codex", model: null, effort: "medium" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 3,
    state: "waiting_ready",
    stateDetail,
    rounds: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    closedAt: null,
  };
}

async function waitForFiles(files: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!files.every((filename) => fs.existsSync(filename))) {
    if (Date.now() > deadline) throw new Error("hot state contention children did not become ready");
    await Bun.sleep(5);
  }
}

async function runTwoWriters(
  collection: "flows" | "pipelines" | "workflows",
  readIds: () => string[],
): Promise<void> {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${collection}-contention-`));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    if (collection === "flows") {
      fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [] }));
    } else if (collection === "pipelines") {
      fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
      fs.writeFileSync(path.join(sandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    } else {
      fs.writeFileSync(path.join(sandbox, "workflows.json"), JSON.stringify({ workflows: [] }));
    }
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(false);
    const release = path.join(sandbox, "release");
    const ready = [path.join(sandbox, "ready-a"), path.join(sandbox, "ready-b")];
    const children = ["a", "b"].map((label, index) => Bun.spawn({
      cmd: [process.execPath, CHILD, collection, label, ready[index]!, release],
      cwd: process.cwd(),
      env: { ...process.env, LLV_STATE_DIR: sandbox },
      stdout: "pipe",
      stderr: "pipe",
    }));
    await waitForFiles(ready);
    fs.writeFileSync(release, "release");
    const exits = await Promise.all(children.map((child) => child.exited));
    if (exits.some((code) => code !== 0)) {
      const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
      throw new Error(`hot state child failed: ${errors.join("\n")}`);
    }
    expect(readIds().sort()).toEqual([
      collection === "flows" ? "flow-a" : collection === "pipelines" ? "pipe-a" : "work-a",
      collection === "flows" ? "flow-b" : collection === "pipelines" ? "pipe-b" : "work-b",
    ]);
    const db = new Database(path.join(sandbox, "state.sqlite"), { strict: true });
    const revision = db.query<{ revision: number }, [string]>(
      "SELECT revision FROM state_collections WHERE collection = ?",
    ).get(collection)?.revision;
    db.close();
    expect(revision).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test("flows serialize two cross-process writers", async () => {
  await runTwoWriters("flows", () => loadFlows().map((flow) => flow.id));
});

test("pipelines serialize two cross-process writers", async () => {
  await runTwoWriters("pipelines", () => loadPipelines().map((pipeline) => pipeline.id));
});

test("workflows serialize two cross-process writers", async () => {
  await runTwoWriters("workflows", () => loadWorkflows().map((workflow) => workflow.id));
});

test("promotion captures a retiring legacy write and demotion publishes later SQLite state", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-release-cutover-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19001";
  const revision = "a".repeat(40);
  try {
    const first = sampleFlow("release-first");
    const retiring = sampleFlow("release-retiring", "legacy-final-write");
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [first] }));
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:19002", revision, hotStateBackend: HOT_STATE_BACKEND,
    }));
    expect(() => loadFlows()).toThrow("waiting for release promotion");
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(false);
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:19001", revision, hotStateBackend: HOT_STATE_BACKEND,
    }));
    let polls = 0;
    const boundary = await establishHotStateCutoverBoundary(() => true, {
      pollMs: 0,
      stablePolls: 2,
      maxPolls: 5,
      schedule: (callback) => {
        polls += 1;
        if (polls === 1) {
          fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [first, retiring] }));
        }
        callback();
        return { unref() {} };
      },
    });
    await initializeHotStateStoresAtStartup(boundary);
    expect(loadFlows().map((flow) => flow.id)).toEqual([first.id, retiring.id]);
    const sqliteRecords = loadFlows();
    sqliteRecords[0]!.stateDetail = "sqlite-after-promotion";
    saveFlows(sqliteRecords);
    checkpointFlowRollbackMirrorForDemotion();
    const rollback = JSON.parse(fs.readFileSync(path.join(sandbox, "flows.json"), "utf8")) as { _sqliteRevision: number; flows: Flow[] };
    expect(rollback._sqliteRevision).toBeGreaterThan(1);
    expect(rollback.flows.map((flow) => [flow.id, flow.stateDetail])).toEqual([
      [first.id, "sqlite-after-promotion"],
      [retiring.id, "legacy-final-write"],
    ]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a portless MCP writer cannot create the migration marker before durable cutover authority", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-portless-cutover-"));
  const revision = "b".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19003";
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [sampleFlow("initial")] }));
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      image: "viewer:fixture",
      container: "viewer-fixture",
      endpoint: "http://127.0.0.1:19003",
      revision,
      hotStateBackend: HOT_STATE_BACKEND,
    }));
    const runPortless = async (name: string) => {
      const resultFile = path.join(sandbox, `${name}.json`);
      const env: NodeJS.ProcessEnv = { ...process.env, [HOT_STATE_RELEASE_REVISION_ENV]: revision };
      delete env.PORT;
      const child = Bun.spawn({
        cmd: [process.execPath, AUTHORITY_CHILD, resultFile],
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited;
      if (exit !== 0) throw new Error(await new Response(child.stderr).text());
      return JSON.parse(fs.readFileSync(resultFile, "utf8")) as {
        ok: boolean;
        records?: Array<{ id: string; stateDetail: string | null; model: string | null }>;
        error?: string;
      };
    };

    expect(await runPortless("before")).toMatchObject({ ok: false, error: expect.stringContaining("promotion") });
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(false);
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({
      flows: [sampleFlow("initial"), sampleFlow("retiring-final")],
    }));
    const boundary = await establishHotStateCutoverBoundary(() => true, {
      pollMs: 0,
      stablePolls: 1,
      maxPolls: 2,
      schedule: (callback) => { callback(); return { unref() {} }; },
    });
    await initializeHotStateStoresAtStartup(boundary);
    expect((await runPortless("after")).records?.map((record) => record.id)).toEqual(["initial", "retiring-final"]);
    const db = new Database(path.join(sandbox, "state.sqlite"), { strict: true });
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM state_collections WHERE collection = 'flows'").get()?.count).toBe(1);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("repeated implicit checkpoints retain nested and structural mutations across async boundaries", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-repeat-checkpoint-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    saveFlows([sampleFlow("retained")]);
    const readFromChild = async (name: string) => {
      const resultFile = path.join(sandbox, `${name}.json`);
      const child = Bun.spawn({
        cmd: [process.execPath, AUTHORITY_CHILD, resultFile],
        cwd: process.cwd(),
        env: { ...process.env, LLV_STATE_DIR: sandbox },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited;
      if (exit !== 0) throw new Error(await new Response(child.stderr).text());
      return (JSON.parse(fs.readFileSync(resultFile, "utf8")) as {
        records: Array<{ id: string; stateDetail: string | null; model: string | null }>;
      }).records;
    };

    const observed: Array<Array<{ id: string; stateDetail: string | null; model: string | null }>> = [];
    await withFlowMutation(async (records, persist) => {
      const retained = records[0]!;
      retained.roles.implementer.model = "gpt-5.6-sol";
      persist();
      observed.push(await readFromChild("nested"));

      retained.stateDetail = "after-await";
      persist();
      observed.push(await readFromChild("retained-reference"));

      records.push(sampleFlow("structural"));
      persist();
      retained.stateDetail = "after-structural";
      persist();
      observed.push(await readFromChild("structural"));
    });

    expect(observed).toEqual([
      [{ id: "retained", stateDetail: null, model: "gpt-5.6-sol" }],
      [{ id: "retained", stateDetail: "after-await", model: "gpt-5.6-sol" }],
      [
        { id: "retained", stateDetail: "after-structural", model: "gpt-5.6-sol" },
        { id: "structural", stateDetail: null, model: null },
      ],
    ]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rollback fencing checkpoints exact revisions before legacy writes resume", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-rollback-fence-"));
  const sqliteRevision = "c".repeat(40);
  const legacyRevision = "d".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19004";
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [sampleFlow("before-cutover")] }));
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      image: "viewer:sqlite",
      container: "viewer-sqlite",
      endpoint: "http://127.0.0.1:19004",
      revision: sqliteRevision,
      hotStateBackend: HOT_STATE_BACKEND,
    }));
    const boundary = await establishHotStateCutoverBoundary(() => true, {
      pollMs: 0,
      stablePolls: 1,
      maxPolls: 2,
      schedule: (callback) => { callback(); return { unref() {} }; },
    });
    await initializeHotStateStoresAtStartup(boundary);
    const promoted = loadFlows();
    promoted[0]!.stateDetail = "sqlite-accepted";
    saveFlows(promoted);
    loadPipelines();
    loadArchivedPipelines();
    loadWorkflows();

    const request = publishHotStateAuthority(sandbox, "fencing", sqliteRevision);
    expect(() => saveFlows([sampleFlow("late-viewer")])).toThrow("fenced");
    const lateResult = path.join(sandbox, "late-mcp.json");
    const childEnv: NodeJS.ProcessEnv = { ...process.env, [HOT_STATE_RELEASE_REVISION_ENV]: sqliteRevision };
    delete childEnv.PORT;
    const child = Bun.spawn({
      cmd: [process.execPath, AUTHORITY_CHILD, lateResult, "write"],
      cwd: process.cwd(),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(fs.readFileSync(lateResult, "utf8"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("fenced"),
    });

    const revisions = await checkpointHotStateRollbackMirrorsForDemotion();
    const acknowledged = acknowledgeHotStateFence(sandbox, request, revisions);
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      image: "viewer:legacy",
      container: "viewer-legacy",
      endpoint: "http://127.0.0.1:19005",
      revision: legacyRevision,
    }));
    publishHotStateAuthority(sandbox, "legacy", legacyRevision, { checkpoint: acknowledged.checkpoint! });

    const legacy = JSON.parse(fs.readFileSync(path.join(sandbox, "flows.json"), "utf8")) as {
      flows: Flow[];
      _sqliteRevision: number;
    };
    legacy.flows.push(sampleFlow("legacy-accepted"));
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify(legacy));
    expect(() => saveFlows([sampleFlow("late-sqlite")])).toThrow("fenced");
    const finalLegacy = JSON.parse(fs.readFileSync(path.join(sandbox, "flows.json"), "utf8")) as { flows: Flow[] };
    expect(finalLegacy.flows.map((flow) => [flow.id, flow.stateDetail])).toEqual([
      ["before-cutover", "sqlite-accepted"],
      ["legacy-accepted", null],
    ]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("release demotion checkpoints all four migrated hot collections", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-demotion-all-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    loadFlows();
    loadPipelines();
    loadArchivedPipelines();
    loadWorkflows();
    await checkpointHotStateRollbackMirrorsForDemotion();
    for (const filename of ["flows.json", "pipelines.json", "pipelines-archive.json", "workflows.json"]) {
      const mirror = JSON.parse(fs.readFileSync(path.join(sandbox, filename), "utf8")) as { _sqliteRevision: number };
      expect(mirror._sqliteRevision).toBe(0);
    }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("incremental reads return one committed snapshot across a concurrent writer", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-snapshot-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [sampleFlow("flow-a"), sampleFlow("flow-b")] }));
    expect(loadFlows()).toHaveLength(2);
    const cached = path.join(sandbox, "cached");
    const begin = path.join(sandbox, "begin");
    const snapshot = path.join(sandbox, "snapshot");
    const release = path.join(sandbox, "release");
    const result = path.join(sandbox, "result.json");
    const child = Bun.spawn({
      cmd: [process.execPath, SNAPSHOT_CHILD, path.join(sandbox, "state.sqlite"), cached, begin, snapshot, release, result],
      cwd: process.cwd(),
      env: { ...process.env, LLV_STATE_DIR: sandbox },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForFiles([cached]);
    const revisionTwo = loadFlows();
    revisionTwo[0]!.stateDetail = "revision-two";
    saveFlows(revisionTwo);
    fs.writeFileSync(begin, "begin");
    await waitForFiles([snapshot]);
    const revisionThree = loadFlows();
    revisionThree[0]!.stateDetail = "revision-three";
    revisionThree[1]!.stateDetail = "revision-three";
    saveFlows(revisionThree);
    fs.writeFileSync(release, "release");
    const exit = await child.exited;
    if (exit !== 0) throw new Error(`snapshot child failed: ${await new Response(child.stderr).text()}`);
    const rows = JSON.parse(fs.readFileSync(result, "utf8")) as Flow[];
    expect(rows.map((flow) => [flow.id, flow.stateDetail])).toEqual([
      ["flow-a", "revision-two"],
      ["flow-b", null],
    ]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("bounded change retention forces a stale reader through a full reload", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-retention-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [sampleFlow("retained")] }));
    loadFlows();
    const database = path.join(sandbox, "state.sqlite");
    const options = {
      collection: "flows",
      schemaVersion: 3,
      busyMessage: "flow state is busy",
      key: (flow: Flow) => flow.id,
      decode: (value: unknown) => value as Flow,
      clone: (flow: Flow) => structuredClone(flow),
    };
    const stale = new SqliteStateCollection<Flow>(database, options);
    const writer = new SqliteStateCollection<Flow>(database, options);
    stale.snapshot();
    for (let revision = 0; revision < 1_040; revision += 1) {
      writer.replaceSync([sampleFlow("retained", `revision-${revision}`)]);
    }
    const db = new Database(database, { strict: true });
    const retainedChanges = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM state_changes WHERE collection = 'flows'").get()!.count;
    const floor = db.query<{ change_floor: number }, []>("SELECT change_floor FROM state_collections WHERE collection = 'flows'").get()!.change_floor;
    db.close();
    expect(retainedChanges).toBeLessThanOrEqual(1_024);
    expect(floor).toBeGreaterThan(1);
    expect(stale.snapshot()[0]!.stateDetail).toBe("revision-1039");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("portable process identity preserves inconclusive owners and reclaims proven pid reuse", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-portable-lease-"));
  process.env.LLV_STATE_DIR = sandbox;
  const alive = spyOn(procBackend, "pidAlive");
  const identity = spyOn(procBackend, "processIdentity");
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [] }));
    loadFlows();
    const database = path.join(sandbox, "state.sqlite");
    const db = new Database(database, { strict: true });
    db.query(`INSERT INTO state_leases(collection, owner_token, owner_pid, owner_start_identity, acquired_at)
      VALUES ('flows', 'recycled', 424242, '424242:old', 0)`).run();
    db.close();
    alive.mockImplementation((pid) => pid === 424242 || pid === process.pid);
    identity.mockImplementation((pid) => pid === 424242 ? null : `${pid}:current`);
    expect(stateLeaseOwnerAlive({ pid: 424242, startIdentity: "424242:old" })).toBe(true);
    identity.mockImplementation((pid) => pid === 424242 ? "424242:new" : `${pid}:current`);
    expect(stateLeaseOwnerAlive({ pid: 424242, startIdentity: "424242:old" })).toBe(false);
    expect(stateLeaseOwnerAlive({ pid: 424242, startIdentity: "424242:new" })).toBe(true);
    saveFlows([sampleFlow("portable")]);
    expect(loadFlows().map((flow) => flow.id)).toEqual(["portable"]);
  } finally {
    alive.mockRestore();
    identity.mockRestore();
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("authority rollback uses a monotonic compare-and-set and rejects delayed fence acknowledgement", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-authority-cas-"));
  const revision = "e".repeat(40);
  try {
    const initial = publishHotStateAuthority(sandbox, "sqlite", revision);
    const fence = publishHotStateAuthority(sandbox, "fencing", revision);
    const restored = restoreHotStateAuthority(sandbox, initial, fence);
    expect(restored).toMatchObject({ mode: "sqlite", releaseRevision: revision });
    expect(restored!.epoch).toBeGreaterThan(fence.epoch);
    expect(() => acknowledgeHotStateFence(sandbox, fence, {
      flows: 1,
      pipelines: 1,
      pipelinesArchive: 1,
      workflows: 1,
    })).toThrow("changed before checkpoint acknowledgement");

    const currentFence = publishHotStateAuthority(sandbox, "fencing", revision);
    const acknowledged = acknowledgeHotStateFence(sandbox, currentFence, {
      flows: 2,
      pipelines: 3,
      pipelinesArchive: 4,
      workflows: 5,
    });
    expect(() => publishHotStateAuthority(sandbox, "sqlite", revision, { epoch: initial.epoch }))
      .toThrow("epoch cannot regress");
    expect(restoreHotStateAuthority(sandbox, initial, fence)).toBeNull();
    expect(readHotStateAuthority(sandbox)).toEqual(acknowledged);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("authority rollback preserves the previous SQLite release readiness", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-authority-ready-"));
  const revision = "9".repeat(40);
  try {
    const initial = publishHotStateAuthority(sandbox, "sqlite", revision);
    const activated = markHotStateActivationReady(sandbox, initial);
    const ready = markViewerReleaseReady(sandbox, activated);
    const transition = publishHotStateAuthority(sandbox, "fencing", revision);

    const restored = restoreHotStateAuthority(sandbox, ready, transition);
    expect(restored).toMatchObject({
      mode: "sqlite",
      releaseRevision: revision,
      activationReadyAt: ready.activationReadyAt,
      releaseReadyAt: ready.releaseReadyAt,
    });
    expect(restored!.epoch).toBeGreaterThan(transition.epoch);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("release readiness cannot precede hot-state activation", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-authority-order-"));
  try {
    expect(() => publishHotStateAuthority(sandbox, "sqlite", "7".repeat(40), {
      releaseReadyAt: "2026-08-09T00:00:00.000Z",
    })).toThrow("requires completed hot-state activation");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the migration dry run leaves the state directory untouched", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-dry-run-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [] }));
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(sandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(sandbox, "workflows.json"), JSON.stringify({ workflows: [] }));
    expect(hotStateMigrationDryRun()).toEqual({
      flows: { records: 0, keys: [] },
      pipelines: { records: 0, keys: [] },
      pipelinesArchive: { records: 0, keys: [] },
      workflows: { records: 0, keys: [] },
    });
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the migration dry run rejects duplicate row keys before opening SQLite", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-dry-run-duplicate-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({
      flows: [sampleFlow("duplicate"), sampleFlow("duplicate")],
    }));
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(sandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(sandbox, "workflows.json"), JSON.stringify({ workflows: [] }));

    expect(hotStateMigrationDryRun).toThrow("duplicate or empty flows migration key: duplicate");
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("complete durable markers let a later cutover bypass damaged JSON mirrors", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-marker-guard-"));
  const revision = "f".repeat(40);
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = "19008";
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [] }));
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(sandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(sandbox, "workflows.json"), JSON.stringify({ workflows: [] }));
    await initializeHotStateStoresAtStartup();
    saveFlows([sampleFlow("sqlite-durable", "newer-than-json")]);

    fs.writeFileSync(path.join(sandbox, "flows.json"), "{");
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:19008",
      revision,
      hotStateBackend: HOT_STATE_BACKEND,
    }));
    const boundary = await establishHotStateCutoverBoundary(() => true, {
      pollMs: 0,
      stablePolls: 1,
      maxPolls: 2,
      schedule: (callback) => { callback(); return { unref() {} }; },
    });
    expect(boundary.reimportLegacy).toBe(false);

    await initializeHotStateStoresAtStartup(boundary);
    expect(readStateCollectionRows(path.join(sandbox, "state.sqlite"), "flows")).toEqual([
      expect.objectContaining({ id: "sqlite-durable", stateDetail: "newer-than-json" }),
    ]);
    expect(fs.readFileSync(path.join(sandbox, "flows.json"), "utf8")).toBe("{");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("malformed legacy sources stay unchanged and receive no migration marker", () => {
  const previous = process.env.LLV_STATE_DIR;
  const cases = [
    { filename: "flows.json", source: "{", collection: "flows", load: loadFlows },
    { filename: "flows.json", source: JSON.stringify({ flows: [{}] }), collection: "flows", load: loadFlows },
    { filename: "workflows.json", source: "{", collection: "workflows", load: loadWorkflows },
    { filename: "workflows.json", source: JSON.stringify({ workflows: [{}] }), collection: "workflows", load: loadWorkflows },
  ] as const;
  try {
    for (const fixture of cases) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${fixture.collection}-malformed-`));
      process.env.LLV_STATE_DIR = sandbox;
      const sourceFile = path.join(sandbox, fixture.filename);
      fs.writeFileSync(sourceFile, fixture.source);
      expect(fixture.load).toThrow();
      expect(fs.readFileSync(sourceFile, "utf8")).toBe(fixture.source);
      const database = path.join(sandbox, "state.sqlite");
      if (fs.existsSync(database)) {
        const db = new Database(database, { strict: true });
        const marker = db.query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM state_collections WHERE collection = ?",
        ).get(fixture.collection);
        db.close();
        expect(marker).toBeNull();
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
    for (const fixture of [
      { filename: "flows.json", load: loadFlows },
      { filename: "workflows.json", load: loadWorkflows },
    ] as const) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-read-error-"));
      process.env.LLV_STATE_DIR = sandbox;
      fs.mkdirSync(path.join(sandbox, fixture.filename));
      expect(fixture.load).toThrow();
      expect(fs.statSync(path.join(sandbox, fixture.filename)).isDirectory()).toBe(true);
      const database = path.join(sandbox, "state.sqlite");
      if (fs.existsSync(database)) {
        const db = new Database(database, { strict: true });
        const marker = db.query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM state_collections WHERE collection = ?",
        ).get(fixture.filename === "flows.json" ? "flows" : "workflows");
        db.close();
        expect(marker).toBeNull();
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("durable migration markers bypass damaged rollback mirrors on later boot", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const cases = [
    {
      name: "flows",
      files: [{ filename: "flows.json", value: { flows: [] } }],
      initialize: loadFlows,
      mode: "opener",
    },
    {
      name: "pipelines",
      files: [
        { filename: "pipelines.json", value: { schemaVersion: 4, pipelines: [] } },
        { filename: "pipelines-archive.json", value: { schemaVersion: 4, pipelines: [] } },
      ],
      initialize: loadPipelines,
      mode: "open-pipelines",
    },
    {
      name: "workflows",
      files: [{ filename: "workflows.json", value: { workflows: [] } }],
      initialize: loadWorkflows,
      mode: "open-workflows",
    },
  ] as const;
  try {
    for (const fixture of cases) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${fixture.name}-damaged-mirror-`));
      process.env.LLV_STATE_DIR = sandbox;
      for (const file of fixture.files) {
        fs.writeFileSync(path.join(sandbox, file.filename), JSON.stringify(file.value));
      }
      expect(fixture.initialize()).toEqual([]);
      expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBe(true);
      for (const file of fixture.files) fs.writeFileSync(path.join(sandbox, file.filename), "{");

      const ready = path.join(sandbox, "reader-ready");
      const child = Bun.spawn({
        cmd: [process.execPath, MIRROR_CHILD, fixture.mode, ready],
        cwd: process.cwd(),
        env: { ...process.env, LLV_STATE_DIR: sandbox },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await child.exited;
      if (exit !== 0) throw new Error(`hot state reader failed: ${await new Response(child.stderr).text()}`);
      expect(fs.existsSync(ready)).toBe(true);
      for (const file of fixture.files) {
        expect(fs.readFileSync(path.join(sandbox, file.filename), "utf8")).toBe("{");
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("a startup rollback checkpoint holds one exact collection revision", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-mirror-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const flow: Flow = {
      id: "mirror-flow",
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: "/mirror.jsonl",
      roles: {
        implementer: { engine: "codex", model: null, effort: "medium" },
        reviewer: { engine: "codex", model: null, effort: "xhigh" },
      },
      baseRef: "base",
      baseMode: "head",
      mode: "auto",
      reviewerMode: "headless",
      roundLimit: 3,
      state: "waiting_ready",
      stateDetail: null,
      rounds: [],
      createdAt: "2026-08-06T00:00:00.000Z",
      closedAt: null,
    };
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [flow] }));
    expect(loadFlows()).toHaveLength(1);

    const writerReady = path.join(sandbox, "writer-ready");
    const openerReady = path.join(sandbox, "opener-ready");
    const release = path.join(sandbox, "writer-release");
    const environment = { ...process.env, LLV_STATE_DIR: sandbox };
    const writer = Bun.spawn({
      cmd: [process.execPath, MIRROR_CHILD, "writer", writerReady, release],
      cwd: process.cwd(),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForFiles([writerReady]);
    const opener = Bun.spawn({
      cmd: [process.execPath, MIRROR_CHILD, "checkpoint-flows", openerReady],
      cwd: process.cwd(),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(50);
    expect(fs.existsSync(openerReady)).toBe(false);
    fs.writeFileSync(release, "release");
    expect(await writer.exited).toBe(0);
    expect(await opener.exited).toBe(0);
    const mirror = JSON.parse(fs.readFileSync(path.join(sandbox, "flows.json"), "utf8")) as {
      _sqliteRevision: number;
      flows: Flow[];
    };
    expect(mirror._sqliteRevision).toBe(2);
    expect(mirror.flows[0]?.stateDetail).toBe("checkpoint-coherent");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("authoritative row corruption fails active stores and stays observable for archives", () => {
  const previous = process.env.LLV_STATE_DIR;
  const insertCorruptRow = (sandbox: string, collection: string, key: string) => {
    const db = new Database(path.join(sandbox, "state.sqlite"), { strict: true });
    db.exec("BEGIN IMMEDIATE");
    db.query(`
      INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
      VALUES (?, ?, '{', 0, 1, 1)
    `).run(collection, key);
    db.query(`
      INSERT INTO state_changes(collection, revision, row_key, operation)
      VALUES (?, 1, ?, 'upsert')
    `).run(collection, key);
    db.query("UPDATE state_collections SET revision = 1 WHERE collection = ?").run(collection);
    db.exec("COMMIT");
    db.close();
  };
  try {
    for (const fixture of [
      { collection: "flows", filename: "flows.json", source: { flows: [] }, load: loadFlows },
      { collection: "workflows", filename: "workflows.json", source: { workflows: [] }, load: loadWorkflows },
    ] as const) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${fixture.collection}-corrupt-row-`));
      process.env.LLV_STATE_DIR = sandbox;
      fs.writeFileSync(path.join(sandbox, fixture.filename), JSON.stringify(fixture.source));
      expect(fixture.load()).toEqual([]);
      insertCorruptRow(sandbox, fixture.collection, "corrupt-row");
      expect(fixture.load).toThrow();
      expect(() => readStateCollectionRows(path.join(sandbox, "state.sqlite"), fixture.collection)).toThrow();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }

    const archiveSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-archive-corrupt-row-"));
    process.env.LLV_STATE_DIR = archiveSandbox;
    fs.writeFileSync(path.join(archiveSandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    fs.writeFileSync(path.join(archiveSandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [] }));
    expect(loadArchivedPipelines()).toEqual([]);
    insertCorruptRow(archiveSandbox, "pipelines_archive", "corrupt-row");
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    expect(loadArchivedPipelines()).toEqual([]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    fs.rmSync(archiveSandbox, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("first boot imports every store once and folds in the pipeline archive", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-migration-"));
  process.env.LLV_STATE_DIR = sandbox;
  const flow: Flow = {
    id: "migrated-flow",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/flow.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "medium" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 3,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    closedAt: null,
  };
  const stages: PipelineStage[] = [{
    id: "build",
    kind: "run",
    "prompt": "build",
    next: null,
    effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null },
  }];
  const active = buildPipeline({ id: "active01", task: "active", project: "repo", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "2026-08-06T00:00:00.000Z" });
  const archived = buildPipeline({ id: "archive1", task: "archive", project: "repo", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
  archived.state = "closed";
  archived.closedAt = "2026-07-02T00:00:00.000Z";
  archived.cursor = null;
  const template = normalizeTemplate({
    name: "migration",
    stages: [
      { kind: "implement", agent: { engine: "codex", model: null, effort: "medium" }, scope: "store" },
      { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: "xhigh" } },
    ],
  })!;
  const workflow = buildWorkflow({ id: "work0001", name: "migration", task: "workflow", project: "repo", repoDir: "/repo", template, mode: "manual", now: "2026-08-06T00:00:00.000Z" });
  try {
    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ schemaVersion: 3, flows: [flow] }));
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 4, pipelines: [active] }));
    fs.writeFileSync(path.join(sandbox, "pipelines-archive.json"), JSON.stringify({ schemaVersion: 4, pipelines: [archived] }));
    fs.writeFileSync(path.join(sandbox, "workflows.json"), JSON.stringify({ workflows: [workflow] }));
    /* An empty database models a process exit before any collection marker committed. */
    new Database(path.join(sandbox, "state.sqlite"), { create: true }).close();

    expect(hotStateMigrationDryRun()).toMatchObject({
      flows: { records: 1, keys: [flow.id] },
      pipelines: { records: 1, keys: [active.id] },
      pipelinesArchive: { records: 1, keys: [archived.id] },
      workflows: { records: 1, keys: [workflow.id] },
    });
    expect(loadFlows().map((record) => record.id)).toEqual([flow.id]);
    expect(loadPipelines().map((record) => record.id)).toEqual([active.id]);
    expect(loadArchivedPipelines().map((record) => record.id)).toEqual([archived.id]);
    expect(loadWorkflows().map((record) => record.id)).toEqual([workflow.id]);

    const filename = path.join(sandbox, "state.sqlite");
    initializeStateCollections(filename, [
      { collection: "flows", schemaVersion: 3, migrationId: "flows-json-v1", loadRecords: () => [], key: () => "" },
      { collection: "pipelines", schemaVersion: 5, migrationId: "pipelines-json-v1", loadRecords: () => [], key: () => "" },
      { collection: "pipelines_archive", schemaVersion: 5, migrationId: "pipelines-archive-json-v1", loadRecords: () => [], key: () => "" },
      { collection: "workflows", schemaVersion: 1, migrationId: "workflows-json-v1", loadRecords: () => [], key: () => "" },
    ]);
    const db = new Database(filename, { strict: true });
    const markers = db.query<{ collection: string; revision: number }, []>(
      "SELECT collection, revision FROM state_collections ORDER BY collection",
    ).all();
    const rows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM state_rows").get()?.count;
    db.close();
    expect(markers).toEqual([
      { collection: "flows", revision: 1 },
      { collection: "pipelines", revision: 1 },
      { collection: "pipelines_archive", revision: 1 },
      { collection: "workflows", revision: 1 },
    ]);
    expect(rows).toBe(4);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an unidentified client writes after activation while retired release identities stay fenced", () => {
  /* A CLI or script may carry no release identity. Servers and managed MCP
     processes retain PORT or an explicit revision, which keeps the retired
     generation outside the promoted writer set. */
  const previousDir = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  const previousRevisionEnv = process.env[HOT_STATE_RELEASE_REVISION_ENV];
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-state-unfenced-client-"));
  const revision = "c".repeat(40);
  try {
    process.env.LLV_STATE_DIR = sandbox;
    delete process.env.PORT;
    delete process.env[HOT_STATE_RELEASE_REVISION_ENV];
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:19101", revision, hotStateBackend: HOT_STATE_BACKEND,
    }));

    const published = publishHotStateAuthority(sandbox, "sqlite", revision);
    expect(hotStateSqliteWriterReady(sandbox)).toBe(false);

    markHotStateActivationReady(sandbox, published);
    expect(hotStateSqliteWriterReady(sandbox)).toBe(true);
    expect(hotStateSqliteWriterReady(sandbox, {
      [HOT_STATE_RELEASE_REVISION_ENV]: "d".repeat(40),
    })).toBe(false);
    expect(hotStateSqliteWriterReady(sandbox, { PORT: "19102" })).toBe(false);
    expect(hotStateSqliteWriterReady(sandbox, {
      [HOT_STATE_RELEASE_REVISION_ENV]: revision,
    })).toBe(true);
    expect(hotStateSqliteWriterReady(sandbox, { PORT: "19101" })).toBe(true);

    /* An activation belonging to a DIFFERENT release than the promoted one is
       still a live handoff, so the fence must hold. */
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:19101", revision: "d".repeat(40), hotStateBackend: HOT_STATE_BACKEND,
    }));
    expect(hotStateSqliteWriterReady(sandbox)).toBe(false);
  } finally {
    if (previousDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousDir;
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    if (previousRevisionEnv === undefined) delete process.env[HOT_STATE_RELEASE_REVISION_ENV];
    else process.env[HOT_STATE_RELEASE_REVISION_ENV] = previousRevisionEnv;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
