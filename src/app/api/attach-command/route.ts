import { NextRequest, NextResponse } from "next/server";

import { resumeSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { attachTargetPath, resolveAttachCommand, type AttachCommand } from "@/lib/agent/attachCommand";
import { agentRegistry } from "@/lib/agent/registry";
import { deliveryFence } from "@/lib/accounts/migration/coordinator";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Best-effort account id → human label; falls back to the id itself. */
function accountLabelFor(engine: AgentEngine, accountId: string): string {
  try {
    const accounts = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
    return accounts.find((account) => account.id === accountId)?.label ?? accountId;
  } catch {
    return accountId;
  }
}

/**
 * `GET /api/attach-command?path=…` — compose the resume/attach command for a
 * conversation instantly from data already in the registry (issue #247 item 2).
 * Pure lookup: no spawning, no viewer-side pane. Works on live, finished, and
 * dead-host conversations alike (the dead-host escape hatch, §5/§6).
 */
export async function GET(req: NextRequest): Promise<NextResponse<AttachCommand | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!path || !pathAllowed(path)) {
    return NextResponse.json({ error: "a valid transcript path is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    /* Account-migration fence: a composed command captures the account's
       CLAUDE_CONFIG_DIR/CODEX_HOME at click time, and mid-migration those
       directories are being moved — composing would hand the user a path in
       transit. Same fence the delivery path consults; refuse during a hold.
       The command is composed for the RESOLVED attach target — a Claude
       subagent resumes through its ROOT session — so the fence checks the
       target's conversation too, or a held root's command would leak out via
       its subagent path (#257). */
    const files = await listFiles();
    const fencePaths = new Set([path]);
    const targetPath = attachTargetPath(path, files);
    if (targetPath) fencePaths.add(targetPath);
    for (const candidate of fencePaths) {
      const conversation = agentRegistry().conversationForPath(candidate);
      if (conversation && deliveryFence(conversation) === "held") {
        return NextResponse.json(
          { error: "account migration in progress — the attach command is available once it completes" },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
    }
    const resolution = resolveAttachCommand(path, {
      files,
      resumeSpecFor,
      accountIdForPath: accountIdFromPath,
      accountLabelFor,
      allowSubagentsForPath: (p) => agentRegistry().launchProfileForPath(p)?.allowSubagents,
    });
    if (!resolution.ok) {
      return NextResponse.json({ error: resolution.error }, { status: resolution.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(resolution.value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
