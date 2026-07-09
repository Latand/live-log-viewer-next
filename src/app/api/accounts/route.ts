import { NextResponse } from "next/server";

import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { deviceAuthChallenge } from "@/lib/accounts/deviceAuth";
import { paneInfo, paneScreen } from "@/lib/tmux";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // When the registry is degraded it still reads as default-only-plus-valid, but any
  // write throws CorruptCodexAccountsError. Skip the best-effort stale-pane cleanup in
  // that state so the read path stays a 200 and the corrupt bytes are left untouched.
  const mutationLocked = codexAccountsMutationLocked();
  const login = new Map<string, { state: "pending" | "idle" | "authenticated"; deviceAuth: { url: string; code: string } | null }>();
  for (const account of listCodexAccounts()) {
    const pane = account.loginPane ? await paneInfo(account.loginPane.paneId) : null;
    const status = codexLoginPaneStatus(account.authPresent, account.loginPane, pane);
    if (status.clear && !mutationLocked) setCodexAccountLoginPane(account.id, null);
    const deviceAuth = status.state === "pending" && pane && account.loginPane ? deviceAuthChallenge(await paneScreen(account.loginPane.paneId)) : null;
    login.set(account.id, { state: status.state, deviceAuth });
  }
  const accounts = listCodexAccounts().map((account) => ({
    id: account.id,
    label: account.label,
    kind: account.kind,
    authPresent: account.authPresent,
    loginPending: login.get(account.id)?.state === "pending",
    loginState: login.get(account.id)?.state ?? "idle",
    deviceAuth: login.get(account.id)?.deviceAuth ?? null,
  }));
  return NextResponse.json({ codex: { active: activeCodexAccountId(), accounts } });
}
