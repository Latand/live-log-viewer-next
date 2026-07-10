import { NextResponse } from "next/server";

import { activeCodexAccountId, codexAccountsMutationLocked, codexLoginPaneStatus, listCodexAccounts, setCodexAccountLoginPane } from "@/lib/accounts/codex";
import { deviceAuthChallenge } from "@/lib/accounts/deviceAuth";
import { activeClaudeAccountId, claudeAccountsMutationLocked, listClaudeAccounts } from "@/lib/accounts/claude";
import { claudeLoginSupervisor } from "@/lib/accounts/claudeLogin";
import { managedCodexRuntime } from "@/lib/accounts/codexRuntime";
import { paneInfo, paneScreen } from "@/lib/tmux";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // When the registry is degraded it still reads as default-only-plus-valid, but any
  // write throws CorruptCodexAccountsError. Skip the best-effort stale-pane cleanup in
  // that state so the read path stays a 200 and the corrupt bytes are left untouched.
  const mutationLocked = codexAccountsMutationLocked();
  const login = new Map<string, Awaited<ReturnType<ReturnType<typeof managedCodexRuntime>["loginSnapshot"]>>>();
  const listed = listCodexAccounts();
  for (const account of listed) {
    if (account.kind === "managed") {
      // Managed logins have no tmux owner. Clear a pre-migration pane record
      // without probing tmux so every managed route stays app-server-only.
      if (account.loginPane && !mutationLocked) setCodexAccountLoginPane(account.id, null);
      login.set(account.id, await managedCodexRuntime().loginSnapshot(account));
      continue;
    }
    if (!account.loginPane) {
      login.set(account.id, { state: account.authPresent ? "authenticated" : "idle", attemptState: null, deviceAuth: null });
      continue;
    }
    // Compatibility adapter for device-login panes created before the
    // app-server migration. Newly managed accounts never enter this branch.
    const pane = account.loginPane ? await paneInfo(account.loginPane.paneId) : null;
    const status = codexLoginPaneStatus(account.authPresent, account.loginPane, pane);
    if (status.clear && !mutationLocked) setCodexAccountLoginPane(account.id, null);
    const deviceAuth = status.state === "pending" && pane && account.loginPane ? deviceAuthChallenge(await paneScreen(account.loginPane.paneId)) : null;
    login.set(account.id, { state: status.state, attemptState: null, deviceAuth });
  }
  const accounts = listed.map((account) => ({
    id: account.id,
    label: account.label,
    kind: account.kind,
    authPresent: account.authPresent,
    loginPending: login.get(account.id)?.state === "pending",
    loginState: login.get(account.id)?.state ?? "idle",
    attemptState: login.get(account.id)?.attemptState ?? null,
    deviceAuth: login.get(account.id)?.deviceAuth ?? null,
  }));
  const claudeAccounts = listClaudeAccounts().map((account) => ({
    id: account.id,
    label: account.label,
    kind: account.kind,
    authPresent: account.authPresent,
    auth: { state: account.authPresent ? "authenticated" : "signed_out", method: null, email: null, plan: null, checkedAt: null },
    limits: { state: "unavailable", session: null, weekly: null, checkedAt: null },
    login: claudeLoginSupervisor.forAccount(account.id),
  }));
  return NextResponse.json({
    codex: { active: activeCodexAccountId(), accounts },
    // A corrupt Claude registry keeps the compatible Codex response available and
    // reduces Claude to immutable legacy Main until an operator repairs it.
    claude: { active: activeClaudeAccountId(), accounts: claudeAccounts, mutationLocked: claudeAccountsMutationLocked() },
  });
}
