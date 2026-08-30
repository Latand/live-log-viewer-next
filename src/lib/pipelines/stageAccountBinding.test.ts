import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";

/* Everything here runs against a throwaway state directory: pipelines, the
   binding record and the role registry all resolve inside this sandbox, and
   nothing in the suite launches a process or reaches a runtime host. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-account-binding-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_STRUCTURED_HOSTS = "0";
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { accountManager } = await import("@/lib/accounts/manager");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } = await import("./engine");
const { savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;

const ATLAS = "project-atlas";
const RESERVED = "acct-reserved";
const SPARE = "acct-spare";
const REPO = path.join(sandbox, "repo");
fs.mkdirSync(REPO, { recursive: true });

function portsAllowing(allowed: string[] | null): PipelinePorts {
  return {
    ...defaultPipelinePorts(),
    preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
    projectForCwd: () => ATLAS,
    allowedAccountIds: () => allowed,
  };
}

function draft(account?: string | null) {
  return {
    task: "Bind accounts to projects",
    repoDir: REPO,
    autoStart: false as const,
    stages: [{
      id: "build",
      kind: "run" as const,
      ["prompt"]: "Implement the scoped change",
      next: null,
      ...(account === undefined ? {} : { account }),
    }],
  };
}

beforeEach(() => {
  savePipelines([]);
});

test("a stage may name an account the project allows", async () => {
  const result = await createPipelineFromRequest(draft(RESERVED), portsAllowing([RESERVED, SPARE]), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.project).toBe(ATLAS);
  expect(result.pipeline?.stages[0]?.account).toBe(RESERVED);
});

test("a stage naming an account outside the project's allowed set is refused, and names the allowed ones", async () => {
  const result = await createPipelineFromRequest(draft(SPARE), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.status).toBe(400);
  expect(result.error).toContain(SPARE);
  expect(result.error).toContain(RESERVED);
  expect(result.error).toContain(ATLAS);
  expect(result.violations?.[0]?.field).toBe("stages[0].account");
  /* Refused means nothing was stored: a plan that could never launch does not
     become a draft the operator has to clean up. */
  expect(result.pipeline).toBeUndefined();
});

test("an unbound project accepts any named account, exactly as before", async () => {
  const result = await createPipelineFromRequest(draft(SPARE), portsAllowing(null), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.stages[0]?.account).toBe(SPARE);
});

test("a stage that names no account is untouched by the binding", async () => {
  const result = await createPipelineFromRequest(draft(), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.stages[0]?.account).toBeUndefined();
});

test("override-stage pins an allowed account, refuses a forbidden one and clears the pin", async () => {
  const created = await createPipelineFromRequest(draft(), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const pinned = await patchPipeline(id, { action: "override-stage", stageId: "build", account: RESERVED }, portsAllowing([RESERVED]));
  expect(pinned.error).toBeUndefined();
  expect(pinned.pipeline?.stages[0]?.account).toBe(RESERVED);

  const refused = await patchPipeline(id, { action: "override-stage", stageId: "build", account: SPARE }, portsAllowing([RESERVED]));
  expect(refused.status).toBe(409);
  expect(refused.error).toContain(SPARE);

  /* The refusal left the earlier pin standing rather than half-applying. */
  const afterRefusal = await patchPipeline(id, { action: "override-stage", stageId: "build", prompt: "unchanged pin probe" }, portsAllowing([RESERVED]));
  expect(afterRefusal.pipeline?.stages[0]?.account).toBe(RESERVED);

  const cleared = await patchPipeline(id, { action: "override-stage", stageId: "build", account: null }, portsAllowing([RESERVED]));
  expect(cleared.error).toBeUndefined();
  expect(cleared.pipeline?.stages[0]?.account).toBeUndefined();
});

test("add-stage refuses a stage whose account the project forbids", async () => {
  const created = await createPipelineFromRequest(draft(), portsAllowing([RESERVED]), {
    allowOperatorDraftWithoutLineage: true,
  });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const refused = await patchPipeline(id, {
    action: "add-stage",
    stage: { id: "verify", kind: "run", prompt: "Verify the change", next: null, account: SPARE },
  }, portsAllowing([RESERVED]));
  expect(refused.status).toBe(400);
  expect(refused.error).toContain(SPARE);

  const accepted = await patchPipeline(id, {
    action: "add-stage",
    stage: { id: "verify", kind: "run", prompt: "Verify the change", next: null, account: RESERVED },
  }, portsAllowing([RESERVED]));
  expect(accepted.error).toBeUndefined();
  expect(accepted.pipeline?.stages.map((stage) => stage.account)).toEqual([undefined, RESERVED]);
});

/* The launch seam itself. A refusal here is what parks the stage with the
   reason on the record — the spawn never reaches a reservation, so nothing is
   launched on an account the project forbids. */
function spawnInput(account: string | null) {
  return {
    role: {
      roleId: "builder" as const,
      engine: "claude" as const,
      model: "claude-opus-5",
      effort: "xhigh",
      access: "read-write" as const,
      promptScaffold: "Builder guidance",
    },
    cwd: sandbox,
    project: ATLAS,
    requestedAccountId: account,
    title: "Bind accounts to projects · build",
    ["prompt"]: "Implement the scoped change",
    parentPath: null,
    clientAttemptId: "stage_account_binding_attempt",
    membership: {
      kind: "pipeline" as const,
      containerId: "pipeline-stage-account",
      role: "builder",
      slot: "build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: null,
    },
    creatorConversationId: null,
  };
}

test("the launch refuses an account the project forbids, before any launch is reserved", async () => {
  const reservations: unknown[] = [];
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "not_allowed",
    accountId: SPARE,
    allowedAccountIds: [RESERVED],
  }));
  try {
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(SPARE), (reservation) => { reservations.push(reservation); }))
      .rejects.toThrow(`claude account ${SPARE} is not allowed on project ${ATLAS} (allowed claude accounts: ${RESERVED})`);
    expect(resolve.mock.calls[0]?.[1]).toEqual({ project: ATLAS, requestedId: SPARE });
    expect(reservations).toEqual([]);
  } finally {
    resolve.mockRestore();
  }
});

test("every allowed account out of capacity is reported as capacity, not solved by crossing the boundary", async () => {
  const resetsAt = Math.floor(Date.parse("2026-08-30T11:00:00.000Z") / 1_000);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "exhausted",
    resetsAt,
    allowedAccountIds: [RESERVED],
  }));
  try {
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(null), () => {}))
      .rejects.toThrow(`no allowed claude account has capacity for project ${ATLAS} (allowed claude accounts: ${RESERVED}); resetsAt=2026-08-30T11:00:00.000Z`);
  } finally {
    resolve.mockRestore();
  }
});
