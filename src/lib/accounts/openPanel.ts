/**
 * Cross-surface request to open the existing Accounts panel focused on one
 * account (issue #229). A header account badge dispatches it; the limits
 * footer's per-engine block answers by opening its panel scrolled to that
 * account. No new menu is introduced — this only steers the existing surface.
 *
 * Desktop: the limits footer is always mounted, so the window event lands
 * synchronously. Mobile: the footer mounts only once the project drawer opens,
 * so the most recent request is also retained briefly and claimed by that
 * late-mounting block on mount.
 */

export interface AccountPanelRequest {
  engine: "claude" | "codex";
  accountId: string;
}

const EVENT = "llv:open-accounts";
/** How long a request stays claimable by a late-mounting listener. */
const PENDING_TTL_MS = 5_000;

let pending: (AccountPanelRequest & { at: number }) | null = null;

/** Ask `engine`'s accounts surface to open, focused on `accountId`. */
export function requestAccountPanel(engine: "claude" | "codex", accountId: string): void {
  pending = { engine, accountId, at: Date.now() };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AccountPanelRequest>(EVENT, { detail: { engine, accountId } }));
  }
}

/** Claim a request dispatched just before this engine's block mounted (mobile
    drawer). Returns and clears it only while fresh and engine-matched. */
export function consumePendingAccountPanel(engine: "claude" | "codex"): AccountPanelRequest | null {
  if (!pending || pending.engine !== engine) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  const { accountId } = pending;
  pending = null;
  return { engine, accountId };
}

/** Subscribe to open requests. Returns an unsubscribe function. */
export function onAccountPanelRequest(handler: (request: AccountPanelRequest) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AccountPanelRequest>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
