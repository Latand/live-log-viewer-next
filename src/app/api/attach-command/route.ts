import { NextRequest, NextResponse } from "next/server";

import { resumeSpecFor, resumeSpecForSession, type AgentEngine } from "@/lib/agent/cli";
import { attachTargetPath, resolveAttachCommand, resolveLaunchAttachCommand, type AttachCommand, type AttachResolution } from "@/lib/agent/attachCommand";
import { agentRegistry } from "@/lib/agent/registry";
import { deliveryFence } from "@/lib/accounts/migration/coordinator";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { cachedFileScan } from "@/lib/scanner/scanCache";
import { pathAllowed } from "@/lib/scanner/roots";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { FileEntry, ApiError } from "@/lib/types";

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

/** Account id → managed home for composing a launch's resume command. */
function homeForAccount(engine: AgentEngine, accountId: string): string | null {
  try {
    const accounts = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
    return accounts.find((account) => account.id === accountId)?.home ?? null;
  } catch {
    return null;
  }
}

function jsonFor(resolution: AttachResolution): NextResponse<AttachCommand | ApiError> {
  return resolution.ok
    ? NextResponse.json(resolution.value, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: resolution.error }, { status: resolution.status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Resolve a `spawn:<launchId>` launch window (round-1 P1#6). The queued
 * placeholder's transcript path is synthetic — handing it to the filesystem-path
 * endpoint produced HTTP 400. Instead resolve the durable launch receipt: prefer
 * the materialized transcript once scanned, otherwise compose the resume command
 * from the receipt's recorded account home, cwd, and session id.
 */
function resolveLaunchPath(launchId: string, files: FileEntry[]): NextResponse<AttachCommand | ApiError> {
  const registry = agentRegistry();
  const snapshot = registry.readOnlySnapshot();
  const receipt = snapshot.receipts[launchId] ?? null;
  const conversation = receipt ? snapshot.conversations[receipt.conversationId] ?? null : null;
  /* Migration fence: the same hold the transcript path honours. */
  if (conversation && deliveryFence(conversation) === "held") {
    return NextResponse.json(
      { error: "account migration in progress — the attach command is available once it completes" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  const generationPath = conversation?.generations.at(-1)?.path ?? receipt?.artifactPath ?? null;
  const materializedPath = generationPath && pathAllowed(generationPath) && files.some((file) => file.path === generationPath)
    ? generationPath
    : null;
  /* The receipt records the launch as requested; the conversation's current
     generation records what it runs on now (an applied reconfigure lands
     there, never on the receipt). Prefer the live profile so this flow and the
     transcript-path flow compose the same command (#663). */
  const liveProfile = conversation?.generations.at(-1)?.launchProfile ?? null;
  return jsonFor(resolveLaunchAttachCommand({
    receipt: receipt
      ? {
        engine: receipt.engine,
        cwd: liveProfile?.cwd || receipt.cwd,
        accountId: receipt.accountId,
        key: receipt.key,
        launchProfile: liveProfile ?? receipt.launchProfile,
      }
      : null,
    materializedPath,
    resolveByPath: (target) => resolveAttachCommand(target, {
      files,
      resumeSpecFor,
      accountIdForPath: accountIdFromPath,
      accountLabelFor,
      launchProfileForPath: (p) => registry.launchProfileForPath(p),
    }),
    resumeSpecForSession,
    homeForAccount,
    accountLabelFor,
  }));
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
  if (!path) {
    return NextResponse.json({ error: "a valid transcript path is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    /* A launch window's path is the synthetic `spawn:<launchId>`, not a
       filesystem path (round-1 P1#6): resolve it through the durable receipt /
       conversation identity so the queued window's terminal control composes a
       real command instead of 400-ing on `pathAllowed`. */
    if (path.startsWith("spawn:")) {
      const files = (await cachedFileScan()).snapshot.files;
      return resolveLaunchPath(path.slice("spawn:".length), files);
    }
    if (!pathAllowed(path)) {
      return NextResponse.json({ error: "a valid transcript path is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    /* Account-migration fence: a composed command captures the account's
       CLAUDE_CONFIG_DIR/CODEX_HOME at click time, and mid-migration those
       directories are being moved — composing would hand the user a path in
       transit. Same fence the delivery path consults; refuse during a hold.
       The command is composed for the RESOLVED attach target — a Claude
       subagent resumes through its ROOT session — so the fence checks the
       target's conversation too, or a held root's command would leak out via
       its subagent path (#257). */
    /* Instant by construction (#561): the command is composed from data the
       viewer already holds — the account home, the resume session id, and the
       conversation's recorded cwd. Reading the shared scan snapshot instead of
       launching a private full-corpus scan removes the multi-second wait the
       operator saw; the snapshot is the same one the board is rendering. */
    const files = (await cachedFileScan(undefined, path)).snapshot.files;
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
      launchProfileForPath: (p) => agentRegistry().launchProfileForPath(p),
    });
    if (!resolution.ok) {
      return NextResponse.json({ error: resolution.error }, { status: resolution.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(resolution.value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
