import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { latestLedgerDeployment, ledgerDeployments } from "./deploymentLedger";
import type { ViewerDeploymentPhase, ViewerDeploymentStatus } from "./contracts";

/**
 * The read-only view of the durable deployment ledger, and the one question it
 * could not answer until #1262: which deployment happened LAST.
 *
 * Every fixture here carries records older than the answer, because that is the
 * condition the defect needed. A ledger holding one deployment agrees with
 * itself whatever the ordering; the seat tick reported a rolled-back deployment
 * against a healthy production because the ledger held a day of them and the
 * ordering it was sliced from — the entity id, a random UUID per deployment —
 * has nothing to do with time.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-ledger-"));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function status(over: { id: string; phase: ViewerDeploymentPhase; createdAt: string; terminal?: boolean }): ViewerDeploymentStatus {
  return {
    deploymentId: over.id,
    idempotencyKey: `key-${over.id}`,
    requestedRevision: "main",
    revision: "0".repeat(40),
    phase: over.phase,
    terminal: over.terminal ?? true,
    candidate: null,
    previous: null,
    mcpRuntime: { candidate: null, previous: null, publications: [], health: [] },
    health: [],
    error: null,
    owner: { pid: 1, startIdentity: "host" } as ViewerDeploymentStatus["owner"],
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
    revisionNumber: 1,
  };
}

/** A ledger written the way the runtime host writes one: entity rows keyed by
    a deployment id that says nothing about when the deployment ran. */
function ledger(name: string, rows: { status: ViewerDeploymentStatus; updatedAt: number | null }[]): NodeJS.ProcessEnv {
  const file = path.join(SANDBOX, `${name}.sqlite`);
  const db = new Database(file, { create: true });
  db.exec(`CREATE TABLE entities (
    kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    state_json TEXT NOT NULL, checkpoint_seq INTEGER NOT NULL, updated_at INTEGER,
    PRIMARY KEY(kind, id)
  );`);
  for (const row of rows) {
    db.query("INSERT INTO entities(kind, id, revision, state_json, checkpoint_seq, updated_at) VALUES (?, ?, 1, ?, 1, ?)")
      .run("deployment", row.status.deploymentId, JSON.stringify(row.status), row.updatedAt);
  }
  db.close();
  return { ...process.env, LLV_RUNTIME_JOURNAL: file };
}

/** Ids whose alphabetical order is the reverse of their chronology, which is
    what a random uuid per deployment amounts to. */
const DAY = "2026-08-28";
const HISTORY = [
  { status: status({ id: "deploy_f9", phase: "rolled-back", createdAt: `${DAY}T06:12:00.000Z` }), updatedAt: Date.parse(`${DAY}T06:31:00.000Z`) },
  { status: status({ id: "deploy_c4", phase: "succeeded", createdAt: `${DAY}T08:33:00.000Z` }), updatedAt: Date.parse(`${DAY}T08:40:00.000Z`) },
  { status: status({ id: "deploy_b7", phase: "succeeded", createdAt: `${DAY}T11:36:00.000Z` }), updatedAt: Date.parse(`${DAY}T11:44:00.000Z`) },
  { status: status({ id: "deploy_a2", phase: "succeeded", createdAt: `${DAY}T12:52:00.000Z` }), updatedAt: Date.parse(`${DAY}T13:01:00.000Z`) },
];

test("the latest deployment is the newest one, not the one the id ordering happens to end on", () => {
  const env = ledger("history", HISTORY);
  const latest = latestLedgerDeployment(env);
  expect(latest).toEqual({ state: "ok", value: HISTORY[3]!.status });

  /* The ordering that produced the false signal, kept here so the difference
     between the two reads is a fact of the test rather than a claim: the tail
     the runtime snapshot mirrors ends on the deployment with the largest id,
     which is the rolled-back one from the morning. */
  const tail = ledgerDeployments(1, env);
  expect(tail.state === "ok" && tail.value.at(-1)!.phase).toBe("rolled-back");
});

test("a ledger whose newest deployment did roll back still says so", () => {
  const env = ledger("regressed", [
    ...HISTORY,
    { status: status({ id: "deploy_a1", phase: "rolled-back", createdAt: `${DAY}T14:20:00.000Z` }), updatedAt: Date.parse(`${DAY}T14:33:00.000Z`) },
  ]);
  const latest = latestLedgerDeployment(env);
  expect(latest.state === "ok" && latest.value?.phase).toBe("rolled-back");
  expect(latest.state === "ok" && latest.value?.deploymentId).toBe("deploy_a1");
});

/* Rows written before the ledger carried a write clock have none, and a null
   there must not outrank a record that names a later start. */
test("recency is the record's own start instant, not only the row's write clock", () => {
  const env = ledger("clockless", [
    { status: status({ id: "deploy_z1", phase: "rolled-back", createdAt: `${DAY}T05:00:00.000Z` }), updatedAt: null },
    { status: status({ id: "deploy_a9", phase: "succeeded", createdAt: `${DAY}T15:00:00.000Z` }), updatedAt: null },
  ]);
  const latest = latestLedgerDeployment(env);
  expect(latest.state === "ok" && latest.value?.deploymentId).toBe("deploy_a9");
});

/* The defect one layer in: a read that is right about ordering and still looks
   at a subset. The row's write clock is close to the start instant but is not
   it — an amendment moves the clock and leaves `createdAt` where it was — so
   any window taken over the write clock has a ledger shape that pushes the
   newest deployment out of it. Here thirty older deployments are amended after
   the newest one started, which is enough to bury it under a window of
   twenty-five, and the answer must still be the deployment that ran last. */
test("the newest deployment is found however far the row's write clock buries it", () => {
  const newest = { status: status({ id: "deploy_a0", phase: "succeeded", createdAt: `${DAY}T13:40:00.000Z` }), updatedAt: Date.parse(`${DAY}T13:47:00.000Z`) };
  const amended = Array.from({ length: 30 }, (_, index) => ({
    status: status({
      id: `deploy_e${String(index).padStart(2, "0")}`,
      phase: "rolled-back" as const,
      createdAt: new Date(Date.parse(`${DAY}T02:00:00.000Z`) + index * 60_000).toISOString(),
    }),
    /* Every amendment lands after the newest deployment finished, so the whole
       of a twenty-five row window by this clock is older deployments. */
    updatedAt: Date.parse(`${DAY}T18:00:00.000Z`) + index * 60_000,
  }));
  const env = ledger("amended", [...amended, newest, ...HISTORY]);
  const latest = latestLedgerDeployment(env);
  expect(latest.state === "ok" && latest.value?.deploymentId).toBe("deploy_a0");
  expect(latest.state === "ok" && latest.value?.phase).toBe("succeeded");
});

/* Only the record being asked about has to be readable. A ledger accumulates
   for as long as the host has been deploying, and one corrupt row from months
   ago is not a reason to refuse to say what happened last. */
test("a corrupt older record does not make the newest one unreadable, and a corrupt newest one does", () => {
  const env = ledger("corrupt", [
    { status: { ...status({ id: "deploy_d3", phase: "succeeded", createdAt: `${DAY}T04:00:00.000Z` }), phase: 7 as never }, updatedAt: Date.parse(`${DAY}T04:09:00.000Z`) },
    ...HISTORY,
  ]);
  const latest = latestLedgerDeployment(env);
  expect(latest.state === "ok" && latest.value?.deploymentId).toBe("deploy_a2");

  const broken = ledger("corrupt-newest", [
    ...HISTORY,
    { status: { ...status({ id: "deploy_a0", phase: "succeeded", createdAt: `${DAY}T16:00:00.000Z` }), revision: 7 as never }, updatedAt: Date.parse(`${DAY}T16:08:00.000Z`) },
  ]);
  expect(latestLedgerDeployment(broken).state).toBe("unreadable");
});

test("an empty ledger answers with no deployment, and a missing one stays unreadable", () => {
  expect(latestLedgerDeployment(ledger("empty", []))).toEqual({ state: "ok", value: null });
  expect(latestLedgerDeployment({ ...process.env, LLV_RUNTIME_JOURNAL: path.join(SANDBOX, "absent.sqlite") }).state).toBe("unreadable");
});
