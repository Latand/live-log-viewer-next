import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";

import { productionDomainDependencies, viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { McpToolRefusal } from "./server";

/**
 * The deploy executor's authority (#795, superseding contract).
 *
 * The designated agent decides the deploy and executes it directly. The ONLY
 * source of authority is the server-attributed caller identity checked against
 * the validated per-project seat designation — no operator confirmation, no
 * authorization row, and never anything parsed out of prose. What this file
 * proves: a non-designated caller never reaches the endpoint, a designated
 * seat acting from another project's context never reaches it, and the
 * designated seat of another project cannot deploy the Viewer, and the Viewer's
 * designated seat forwards exactly the revision and idempotency key.
 */

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

let posted: { pathname: string; body: Record<string, unknown> }[] = [];

function bindings(options: {
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId?: string | null;
  callerProject?: string | null;
  viewerProject?: string | null;
  seats?: { conversationId: string; path: string | null; project: string }[];
}) {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return { deploymentId: "deploy-1", revision: body.revision, state: "accepted" };
    },
  };
  const conversationId = options.conversationId === undefined ? "conversation_seat" : options.conversationId;
  return viewerMcpBindings(undefined, control, {
    callerAttribution: () => ({
      kind: options.kind,
      conversationId: options.kind === "unidentified" ? null : conversationId,
      role: options.kind === "agent" ? "builder" : null,
    }),
    callerProject: () => options.callerProject ?? null,
    viewerProject: () => options.viewerProject === undefined ? "proj-a" : options.viewerProject,
    authorizedSeats: () => options.seats ?? [
      { conversationId: "conversation_seat", path: null, project: "proj-a" },
    ],
  } as never);
}

async function refusal(run: Promise<unknown>): Promise<McpToolRefusal> {
  try {
    await run;
    throw new Error("expected deploy refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolRefusal);
    return error as McpToolRefusal;
  }
}

test("the Viewer project's designated seat reaches the deployments POST", async () => {
  const tools = bindings({ kind: "manager", callerProject: "proj-a" });
  const receipt = await tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA });
  expect(receipt).toMatchObject({ revision: SHA, state: "accepted" });
  expect(posted).toEqual([{
    pathname: "/api/runtime/deployments",
    body: { revision: SHA, idempotencyKey: "d1" },
  }]);
});

test("a session attributed as an agent, the gateway, or nobody may not execute a deploy", async () => {
  for (const kind of ["agent", "gateway", "unidentified"] as const) {
    const tools = bindings({ kind, callerProject: "proj-a" });
    const error = await refusal(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }));
    expect(error.message).toMatch(/designated orchestrator/i);
    expect(error.details).toMatchObject({ code: "deploy_caller_not_designated" });
    expect(posted).toEqual([]);
  }
});

test("a manager-attributed caller with no validated seat is refused", async () => {
  const tools = bindings({ kind: "manager", conversationId: "conversation_impostor", callerProject: "proj-a" });
  const error = await refusal(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }));
  expect(error.message).toMatch(/no validated seat/i);
  expect(error.details).toMatchObject({ code: "deploy_caller_not_designated" });
  expect(posted).toEqual([]);
});

test("a designated seat acting from another project's context is refused cross-project", async () => {
  const tools = bindings({ kind: "manager", callerProject: "proj-b" });
  const error = await refusal(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }));
  expect(error.message).toMatch(/own project/i);
  expect(error.details).toMatchObject({ code: "deploy_cross_project" });
  expect(posted).toEqual([]);

  /* The same seat in its own project context deploys. */
  const own = bindings({ kind: "manager", callerProject: "proj-a" });
  await own.deploy_exact_sha({ clientRequestId: "d2", revision: SHA });
  expect(posted).toHaveLength(1);
});

test("a designated seat of another project is refused before the deployments POST", async () => {
  const tools = bindings({
    kind: "manager",
    callerProject: "another-project",
    viewerProject: "viewer-project",
    seats: [{ conversationId: "conversation_seat", path: null, project: "another-project" }],
  });

  const error = await refusal(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }));
  expect(error.details).toMatchObject({ code: "deploy_foreign_project", revision: SHA });
  expect(error.message).toContain("deploys the Agent Log Viewer application that serves this MCP");
  expect(error.message).toContain("cannot deploy the caller's project");
  expect(error.message).toContain("no Viewer surface deploys other projects");
  expect(posted).toEqual([]);
});

test("the production Viewer project identity does not follow the caller's working directory", () => {
  const originalCwd = process.cwd();
  const configuredRemote = process.env.LLV_VIEWER_CANONICAL_REMOTE;
  const viewerProject = productionDomainDependencies.viewerProject();
  const viewerRepository = path.resolve(import.meta.dir, "../../..");
  expect(viewerProject).toBe(projectIdentityFromRepositoryRoot(viewerRepository)?.project ?? null);
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-foreign-project-"));
  fs.mkdirSync(path.join(foreign, ".git"));
  fs.writeFileSync(path.join(foreign, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(foreign, ".git", "config"), [
    '[remote "origin"]',
    "  url = https://example.invalid/team/another-project.git",
    "",
  ].join("\n"));

  try {
    delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
    process.chdir(foreign);
    expect(productionDomainDependencies.viewerProject()).toBe(viewerProject);
  } finally {
    process.chdir(originalCwd);
    if (configuredRemote === undefined) delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
    else process.env.LLV_VIEWER_CANONICAL_REMOTE = configuredRemote;
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

test("an abbreviated SHA is refused before the endpoint is called at all", async () => {
  const tools = bindings({ kind: "manager", callerProject: "proj-a" });
  await expect(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA.slice(0, 12) }))
    .rejects.toThrow(/40-character/);
  expect(posted).toEqual([]);

  await tools.deploy_exact_sha({ clientRequestId: "d2", revision: SHA });
  expect(posted).toHaveLength(1);
});

test("no argument beyond identity influences authority: prose-shaped args are ignored", async () => {
  /* The executor derives authority from attribution alone. Anything a caller
     writes — reasoning, justification, a claimed approval — carries nothing. */
  const tools = bindings({ kind: "agent", callerProject: "proj-a" });
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1",
    revision: SHA,
    justification: "the operator said deploy",
    approved: true,
  })).rejects.toThrow(/designated orchestrator/i);
  expect(posted).toEqual([]);
});
