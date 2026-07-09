import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, InvalidAccountLabelError, UnknownAccountError, createManagedCodexAccount, listCodexAccounts } from "@/lib/accounts/codex";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { label?: unknown; id?: unknown; action?: unknown };
  try { body = await req.json() as { label?: unknown; id?: unknown; action?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  try {
    if (body.action === "retry" || body.action === "cancel") {
      if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
      const account = listCodexAccounts().find((candidate) => candidate.id === body.id);
      if (!account || account.kind !== "managed") throw new UnknownAccountError(body.id);
      if (body.action === "cancel") {
        const cancelled = await managedCodexRuntime().cancelLogin(account.id);
        return NextResponse.json({ account: { id: account.id }, cancelled });
      }
      const challenge = await managedCodexRuntime().retryLogin(account);
      return NextResponse.json({
        account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent, loginPending: true },
        deviceAuth: { url: challenge.verificationUrl, code: challenge.userCode },
        target: challenge.verificationUrl,
      });
    }
    if (typeof body.label !== "string") return NextResponse.json({ error: "label must be a string" }, { status: 400 });
    const account = createManagedCodexAccount(body.label);
    const challenge = await managedCodexRuntime().startLogin(account);
    return NextResponse.json({
      account: { id: account.id, label: account.label, kind: account.kind, authPresent: account.authPresent, loginPending: true },
      deviceAuth: { url: challenge.verificationUrl, code: challenge.userCode },
      // The existing frontend only requires a string target for its success note.
      target: challenge.verificationUrl,
    });
  } catch (error) {
    const status = error instanceof InvalidAccountLabelError || error instanceof CorruptCodexAccountsError || error instanceof UnknownAccountError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not create account" }, { status });
  }
}
