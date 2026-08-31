import { NextRequest, NextResponse } from "next/server";

import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { accountProjectOverrides } from "@/lib/accounts/accountOverrides";
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
  AccountProjectBindingsUnreadableError,
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
  /* Deliberate choices of an account outside this project's pool. Read once for
     both engines, and rendered beside the pool rather than instead of it: the
     pool is what the Viewer selects from on its own, and this is what somebody
     decided to do anyway. */
  const overrides = accountProjectOverrides({ project });
  return {
    project,
    projectName: displayNames[project] ?? project,
    engines: Object.fromEntries(ENGINES.map((engine) => [
      engine,
      projectEngineAccounts(
        project,
        engine,
        accountsFor(engine),
        bindings,
        carryingAccountIds(carrying, project, engine),
        overrides,
      ),
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
  try {
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
  } catch (error) {
    /* A damaged record answers with what is wrong with it. An empty relation
       here would read as "nothing is restricted", which is the panel showing
       every account allowed on a project that reserved one. */
    if (error instanceof AccountProjectBindingsUnreadableError) return unreadableResponse(error);
    throw error;
  }
}

const FAILURE_STATUS: Record<string, number> = {
  INVALID_ENGINE: 400,
  INVALID_ACCOUNT: 400,
  INVALID_PROJECT: 400,
  /* The record on disk needs the operator, and until it gets them no project
     selects an account. A conflict rather than a server fault: the request was
     well formed and the state it addresses is the thing that is wrong. */
  RECORD_UNREADABLE: 409,
  /* Nothing was refused and nothing was written; the same request works on
     retry, which is what 503 tells a caller. */
  BUSY: 503,
  STORE_ERROR: 500,
  NOT_CONFIRMED: 500,
};

/** The one answer for a damaged record: its message, and never a view built
    from a record this process could not read. */
function unreadableResponse(error: AccountProjectBindingsUnreadableError): NextResponse {
  return NextResponse.json(
    { error: "RECORD_UNREADABLE", message: error.message, bindings: [] },
    { status: 409, headers },
  );
}

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
  /* Taken here, around the mutation AND the confirming view, so an operator's
     click queues behind another account mutation instead of being turned away
     by it — the store re-enters this transaction rather than acquiring twice.
     It also makes the view below a read of the record this write produced. */
  try {
    return await withAccountMutationLockAsync(async () => {
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
    });
  } catch (error) {
    if (error instanceof AccountProjectBindingsUnreadableError) return unreadableResponse(error);
    throw error;
  }
}
