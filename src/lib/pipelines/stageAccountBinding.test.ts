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
/* The account catalog the real resolution reads is derived from HOME, and the
   one test below that does NOT stub the resolution must read this sandbox. */
process.env.HOME = path.join(sandbox, "home");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
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

/* Two projects with different allowed sets, so a draft can be moved between
   them: ATLAS reserves one account, NEBULA reserves the other. */
const NEBULA = "project-nebula";
const VEGA = "project-vega";
const OTHER_REPO = path.join(sandbox, "repo-other");
const SHARED_REPO = path.join(sandbox, "repo-shared");
for (const dir of [OTHER_REPO, SHARED_REPO]) fs.mkdirSync(dir, { recursive: true });
const PROJECT_BY_REPO: Record<string, string> = { [REPO]: ATLAS, [OTHER_REPO]: NEBULA, [SHARED_REPO]: VEGA };
const ALLOWED_BY_PROJECT: Record<string, string[]> = { [ATLAS]: [RESERVED], [NEBULA]: [SPARE], [VEGA]: [RESERVED, SPARE] };

function portsAcross(): PipelinePorts {
  return {
    ...defaultPipelinePorts(),
    preflightRepo: (repoDir: string) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: sandbox }),
    projectForCwd: (cwd: string) => PROJECT_BY_REPO[cwd] ?? ATLAS,
    allowedAccountIds: (project: string) => ALLOWED_BY_PROJECT[project] ?? null,
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

/* Moving a draft to another repository moves it to another PROJECT, and the
   allowed set travels with the project rather than with the plan. A pin that
   was legal where the draft was written can be illegal where it lands, so the
   same reading that refuses it at create runs again here — otherwise a draft
   the launch will only ever park becomes the operator's to discover later. */
test("update-draft re-reads the binding when a draft moves to another project", async () => {
  const created = await createPipelineFromRequest(draft(RESERVED), portsAcross(), {
    allowOperatorDraftWithoutLineage: true,
  });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const refused = await patchPipeline(id, { action: "update-draft", repoDir: OTHER_REPO }, portsAcross());
  expect(refused.status).toBe(400);
  expect(refused.error).toContain(RESERVED);
  expect(refused.error).toContain(NEBULA);
  expect(refused.violations?.[0]?.field).toBe("stages[0].account");

  /* Refused means the move did not half-apply: the draft is still the project
     and repository it was, with the pin the binding there still allows. */
  const unmoved = await patchPipeline(id, { action: "update-draft", task: "Bind accounts to projects" }, portsAcross());
  expect(unmoved.pipeline?.project).toBe(ATLAS);
  expect(unmoved.pipeline?.repoDir).toBe(REPO);
  expect(unmoved.pipeline?.stages[0]?.account).toBe(RESERVED);
});

test("update-draft moves a draft whose pin the destination project allows", async () => {
  const created = await createPipelineFromRequest(draft(RESERVED), portsAcross(), {
    allowOperatorDraftWithoutLineage: true,
  });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);

  const moved = await patchPipeline(id, { action: "update-draft", repoDir: SHARED_REPO }, portsAcross());
  expect(moved.error).toBeUndefined();
  expect(moved.pipeline?.project).toBe(VEGA);
  expect(moved.pipeline?.stages[0]?.account).toBe(RESERVED);
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
    runtimeProfile: { access: "read-write" as const, sandbox: "full" as const },
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

test("a damaged binding record parks the stage instead of launching it on any account", async () => {
  /* The one test here that runs the REAL project resolution: the record on
     disk is what decides, and a record that cannot be read must refuse the
     launch rather than answer "this project is unbound" and hand the stage
     whichever account the engine happens to be pointing at. */
  const record = path.join(process.env.LLV_STATE_DIR!, "account-project-bindings.json");
  fs.writeFileSync(record, '{"schemaVersion":1,"bindings":[{"engine":"claude"', "utf8");
  const reservations: unknown[] = [];
  try {
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(RESERVED), (reservation) => { reservations.push(reservation); }))
      .rejects.toThrow(/account-project-bindings\.json is unreadable/);
    /* Nothing was reserved, so the parked stage retries cleanly once the
       operator repairs or removes the record. */
    expect(reservations).toEqual([]);
    await expect(defaultPipelinePorts().spawnAgent(spawnInput(null), () => {}))
      .rejects.toThrow(/is unreadable/);
  } finally {
    fs.rmSync(record, { force: true });
  }
});

test("a damaged binding record answers create and override with the same conflict the launch gives", async () => {
  /* The read throws so nothing can mistake a damaged record for an unbound
     project, and here that throw has to become an ANSWER. Propagated, it is a
     500 on a request nothing is wrong with; the state is what needs repair, so
     it is the same 409 — with the same wording — the launch, the reseat and the
     binding route give, and one repair clears all of them. */
  const record = path.join(process.env.LLV_STATE_DIR!, "account-project-bindings.json");
  const realPorts: PipelinePorts = {
    ...defaultPipelinePorts(),
    preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
    projectForCwd: () => ATLAS,
  };

  /* Stored while the record is readable, so the override below has a draft. */
  const stored = await createPipelineFromRequest(draft(RESERVED), portsAllowing(null), {
    allowOperatorDraftWithoutLineage: true,
  });
  expect(stored.pipeline).toBeDefined();

  fs.writeFileSync(record, '{"schemaVersion":1,"bindings":[{"engine":"claude"', "utf8");
  try {
    const created = await createPipelineFromRequest(draft(RESERVED), realPorts, {
      allowOperatorDraftWithoutLineage: true,
    });
    expect(created.status).toBe(409);
    expect(created.error).toMatch(/account-project-bindings\.json is unreadable/);
    expect(created.pipeline).toBeUndefined();

    const overridden = await patchPipeline(stored.pipeline!.id, {
      action: "override-stage",
      stageId: "build",
      account: SPARE,
    }, realPorts);
    expect(overridden.status).toBe(409);
    expect(overridden.error).toMatch(/account-project-bindings\.json is unreadable/);
    /* Refused means unchanged: the pin the draft already carries is still the
       one on record. */
    expect(overridden.pipeline?.stages[0]?.account ?? stored.pipeline!.stages[0]?.account).toBe(RESERVED);

    /* A plan that names no account never reads the record at all, so a damaged
       one cannot block work that was never fenced by it. */
    const unpinned = await createPipelineFromRequest(draft(), realPorts, {
      allowOperatorDraftWithoutLineage: true,
    });
    expect(unpinned.error).toBeUndefined();
    expect(unpinned.pipeline).toBeDefined();
  } finally {
    fs.rmSync(record, { force: true });
  }
});
