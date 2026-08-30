import { NextRequest, NextResponse } from "next/server";

import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import {
  accountProjectRows,
  carrierConversations,
  carryingAccountIds,
  projectEngineAccounts,
  type BoundAccount,
  type CarrierConversation,
} from "@/lib/accounts/projectAccountsView";
import {
  accountProjectBindings,
  bindAccountToProject,
  unbindAccountFromProject,
  type BindingEngine,
} from "@/lib/accounts/projectBindings";
import { agentRegistry } from "@/lib/agent/registry";
import { headCwd } from "@/lib/agent/transcript";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const ENGINES: readonly BindingEngine[] = ["claude", "codex"];

function accountsFor(engine: BindingEngine): BoundAccount[] {
  return (engine === "claude" ? listClaudeAccounts() : listCodexAccounts())
    .map((account) => ({ accountId: account.id, label: account.label }));
}

/**
 * Every registered conversation reduced to the carrier shape, each one keyed to
 * its project by the same resolution the reseat fence uses — fallback included,
 * so an ADOPTED conversation (empty launch profile) is still attributed to the
 * project it is carrying work for instead of dropping out of the view.
 */
function carriers(): CarrierConversation[] {
  const snapshot = agentRegistry().readOnlySnapshot();
  return carrierConversations(
    Object.values(snapshot.conversations).flatMap((conversation) => {
      const generation = conversation.generations.at(-1);
      if (!generation) return [];
      return [{
        engine: conversation.engine,
        busy: conversation.turn.state === "busy",
        accountId: generation.accountId,
        ownership: conversation.projectOwnership,
        launchProfile: generation.launchProfile,
        path: generation.path,
      }];
    }),
    /* Only reached for a conversation that names no project of its own, and
       only for the busy ones — see carrierConversations. */
    (transcript) => {
      const cwd = headCwd(transcript);
      return cwd ? projectForCwd(cwd) : null;
    },
  );
}

function projectView(project: string) {
  const bindings = accountProjectBindings();
  const carrying = carriers();
  const displayNames = projectAliasSnapshot().displayNames;
  return {
    project,
    projectName: displayNames[project] ?? project,
    engines: Object.fromEntries(ENGINES.map((engine) => [
      engine,
      projectEngineAccounts(project, engine, accountsFor(engine), bindings, carryingAccountIds(carrying, project, engine)),
    ])),
    bindings: bindings.filter((binding) => binding.project === project),
  };
}

/**
 * The whole relation, read back from the record (#1279). `?project=` narrows to
 * one project's view — which accounts it may use and which are carrying its
 * work — and without it the answer is every binding plus, per engine, the
 * projects each account is bound to.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requested = request.nextUrl.searchParams.get("project")?.trim();
  if (requested) {
    return NextResponse.json(projectView(canonicalProject(requested)), { headers });
  }
  const bindings = accountProjectBindings();
  const displayNames = projectAliasSnapshot().displayNames;
  return NextResponse.json({
    bindings,
    accounts: Object.fromEntries(ENGINES.map((engine) => [
      engine,
      accountsFor(engine).map((account) => ({
        ...account,
        projects: accountProjectRows(engine, account.accountId, bindings, displayNames),
      })),
    ])),
  }, { headers });
}

const FAILURE_STATUS: Record<string, number> = {
  INVALID_ENGINE: 400,
  INVALID_ACCOUNT: 400,
  INVALID_PROJECT: 400,
  STORE_ERROR: 500,
  NOT_CONFIRMED: 500,
};

/**
 * `action: "add" | "remove"`. What comes back is the record re-read after the
 * write — never an echo of the request — so a caller can tell a binding that
 * landed from an action that answered `ok` and changed nothing.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const action = record?.action;
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "action must be add or remove" }, { status: 400, headers });
  }
  const project = typeof record?.project === "string" ? record.project.trim() : "";
  if (!project || project.length > 256) {
    return NextResponse.json({ error: "INVALID_PROJECT", message: "project is required" }, { status: 400, headers });
  }
  const canonical = canonicalProject(project);
  const result = action === "add"
    ? bindAccountToProject(record?.engine, record?.accountId, canonical)
    : unbindAccountFromProject(record?.engine, record?.accountId, canonical);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.message, bindings: result.bindings },
      { status: FAILURE_STATUS[result.code] ?? 400, headers },
    );
  }
  return NextResponse.json({
    ok: true,
    changed: result.changed,
    bindings: result.bindings,
    /* The confirming read of the project the caller just changed, so the answer
       carries the state the fence will actually enforce. */
    project: projectView(canonical),
  }, { headers });
}
