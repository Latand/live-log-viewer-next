import os from "node:os";

import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, InvalidAccountLabelError, createManagedCodexAccount, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { resolveBinary, shellQuote } from "@/lib/agent/cli";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { spawnCommandWindow } from "@/lib/tmux";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { label?: unknown };
  try { body = await req.json() as { label?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
  try {
    const account = createManagedCodexAccount(body.label);
    const pane = await spawnCommandWindow({
      command: `CODEX_HOME=${shellQuote(account.home)} ${shellQuote(resolveBinary("codex"))} -c cli_auth_credentials_store=file login --device-auth`,
      cwd: os.homedir(),
      windowName: "codex-login",
    });
    setCodexAccountLoginPane(account.id, { paneId: pane.paneId, windowName: "codex-login", startedAt: Date.now() });
    return NextResponse.json({ account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent, loginPending: true }, target: pane.display });
  } catch (error) {
    const status = error instanceof InvalidAccountLabelError || error instanceof CorruptCodexAccountsError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not create account" }, { status });
  }
}
