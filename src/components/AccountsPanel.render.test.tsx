import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ClaudeLoginView, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { translate } from "@/lib/i18n";

import { AccountsPanel, type ProjectAccountContext } from "./AccountsPanel";
import { formatResetClock } from "./rateLimit";

const base = (over: Partial<EngineAccountsState> = {}): EngineAccountsState => ({
  engine: "codex",
  accounts: [
    // Each capacity chip is reconciled from the account's own windows, so the
    // fixture carries the windows the chip percentages come from.
    { id: "main", label: "Main", kind: "legacy", authPresent: true, plan: "Team", loginPending: false, loginState: "authenticated", deviceAuth: null,
      limits: { freshness: "fresh", session: { usedPercent: 88, resetsAt: null, windowMinutes: 300 }, weekly: null } },
    { id: "work", label: "Work", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
      limits: { freshness: "stale", session: null, weekly: { usedPercent: 36, resetsAt: null, windowMinutes: 10_080 } } },
  ],
  active: "main",
  identityVersion: 0,
  status: "ready",
  notice: null,
  challenge: null,
  mutation: null,
  migration: null,
  autoBalance: null,
  refresh: async () => true,
  add: async () => true,
  retryNotice: async () => true,
  select: async () => true,
  submitLoginCode: async () => true,
  cancelLogin: async () => true,
  retryLogin: async () => true,
  remove: async () => true,
  cleanupOrphans: async () => true,
  copyTerminalCommand: async () => true,
  refreshLimits: async () => true,
  useResetCredit: async () => true,
  limitsBusy: null,
  limitsVersion: 0,
  ...over,
});

const render = (state: EngineAccountsState, placement?: "footer" | "header", projectContext?: ProjectAccountContext) =>
  renderToStaticMarkup(<AccountsPanel state={state} onClose={() => {}} placement={placement} projectContext={projectContext} />);

test("titles the panel per engine and keeps the mobile-only backdrop before the dialog", () => {
  expect(render(base())).toContain("Codex accounts");
  expect(render(base({ engine: "claude" }))).toContain("Claude accounts");
  const html = render(base());
  expect(html.indexOf("sm:hidden")).toBeLessThan(html.indexOf('role="dialog"'));
  expect(html.match(/role="dialog"/g)?.length).toBe(1);
});

test("the footer caller keeps the bottom-anchored flyout beside the rail", () => {
  // Default placement is the limits-footer flyout: on desktop it sits to the
  // right of the rail (`sm:left-full`) and shares the mobile bottom sheet.
  const html = render(base());
  expect(html).toContain("sm:left-full");
  expect(html).toContain("sm:bottom-1");
});

test("the header caller drops the panel below the trigger so an overflow-hidden shell can't clip it", () => {
  // The Switchboard header sits at the top of an overflow-hidden modal. A
  // bottom-anchored flyout would grow upward out of that shell and be clipped;
  // the header placement anchors the panel below the trigger and inside the box.
  const html = render(base(), "header");
  expect(html).toContain("sm:top-full");
  expect(html).toContain("sm:mt-2");
  expect(html).toContain("sm:bottom-auto");
  // The header placement drops the upward `sm:bottom-1` anchor that clips.
  expect(html).not.toContain("sm:left-full");
});

test("renders a capacity chip per account and dims the stale one", () => {
  const html = render(base());
  expect(html).toContain("12%");
  expect(html).toContain("64%");
  expect(html).toContain("Team");
  expect(html).toContain("opacity-55"); // the stale Work chip
});

test("the expanded toolbar panel retains project pool, carrier, and outside-pool detail", () => {
  const projectContext: ProjectAccountContext = {
    project: "project-atlas",
    restricted: true,
    allowed: [
      { accountId: "account-north", label: "North star" },
      { accountId: "account-harbor", label: "Harbor light" },
    ],
    carrying: [{ accountId: "account-harbor", label: "Harbor light" }],
    outsidePool: [{ accountId: "account-south", label: "South ridge", at: "2026-08-30T09:00:00.000Z", actor: "operator" }],
  };
  const html = render(base(), "header", projectContext);
  expect(html).toContain('data-project-account-detail="project-atlas"');
  expect(html).toContain("North star");
  expect(html).toContain('data-project-account-carrying="account-harbor"');
  expect(html).toContain("Harbor light · carrying");
  expect(html).toContain('data-project-account-outside-pool="account-south"');
  expect(html).toContain("South ridge · outside the pool");
  expect(html).not.toContain("truncate rounded-full");
});

test("shows account ids and auth health when labels collide", () => {
  const html = render(base({
    engine: "claude",
    accounts: [
      { id: "managed-two", label: "Managed two", kind: "managed", authPresent: true, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null },
      { id: "managed-three", label: "Managed three", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
    ],
    active: "managed-three",
  }));

  expect(html).toContain("managed-two");
  expect(html).toContain("managed-three");
  expect(html).toContain("Signed out");
  expect(html).toContain("Authenticated");
  expect(html).toContain("bg-danger-soft text-danger");
  expect(html).toContain("needs sign-in");
  expect(html).toContain(">Sign in<");
});

test("breaks out each account's session and weekly windows with reset times", () => {
  const nowS = Math.floor(Date.now() / 1000);
  const html = render(base({
    accounts: [
      {
        id: "main", label: "Main", kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
        limits: { freshness: "fresh", session: { usedPercent: 55, resetsAt: nowS + 7200, windowMinutes: 300 }, weekly: { usedPercent: 8, resetsAt: nowS + 259200, windowMinutes: 10_080 } },
      },
    ],
    active: "main",
  }));
  expect(html).toContain('aria-label="Quota windows for Main"');
  expect(html).toContain(translate("en", "limits.5h"));
  expect(html).toContain(translate("en", "limits.week"));
  expect(html).toContain("45%"); // session remaining (100 − 55)
  expect(html).toContain("92%"); // weekly remaining (100 − 8)
  expect(html).toContain("reset"); // both windows carry a reset time
});

test("an exhausted account names when it is rate limited until (#1371)", () => {
  const nowS = Math.floor(Date.now() / 1_000);
  const resetsAt = nowS + 6 * 86_400;
  const html = render(base({
    accounts: [{
      id: "main",
      label: "Main",
      kind: "legacy",
      authPresent: true,
      loginPending: false,
      loginState: "authenticated",
      deviceAuth: null,
      limits: {
        freshness: "stale",
        session: null,
        weekly: { usedPercent: 100, resetsAt, windowMinutes: 10_080 },
      },
    }],
    active: "main",
  }));

  expect(html).toContain(translate("en", "rateLimit.badgeUntil", {
    time: formatResetClock(resetsAt, nowS),
  }));
});

test("a weekly-only account labels its one window by the horizon it carries", () => {
  // A Codex plan with no 5-hour limit reports a single weekly window; the row
  // must read "Week", never the 5h label (issue #606).
  const nowS = Math.floor(Date.now() / 1000);
  const html = render(base({
    accounts: [
      {
        id: "main", label: "Main", kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
        limits: { freshness: "fresh", session: null, weekly: { usedPercent: 15, resetsAt: nowS + 437_631, windowMinutes: 10_080 } },
      },
    ],
    active: "main",
  }));
  const detail = html.match(/<dl[^>]*Quota windows[^>]*>[\s\S]*?<\/dl>/)?.[0] ?? "";
  // Row labels are the <dt> texts; the block's action icons carry path data
  // and button copy that a whole-markup substring check would trip over.
  const labels = [...detail.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]);
  expect(labels).toEqual([translate("en", "limits.week")]);
  expect(detail).toContain("85%"); // weekly remaining (100 - 15)
});

test("a weekly-horizon window in the session field is labelled by its horizon, not its slot", () => {
  // The row label must follow the window's declared length. With a weekly
  // window sitting in the session field — the shape #606 was reported against —
  // the row reads "Week"; a static per-slot label would print "5h" here.
  const nowS = Math.floor(Date.now() / 1000);
  const html = render(base({
    accounts: [
      {
        id: "main", label: "Main", kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
        limits: { freshness: "fresh", session: { usedPercent: 15, resetsAt: nowS + 437_631, windowMinutes: 10_080 }, weekly: null },
      },
    ],
    active: "main",
  }));
  const detail = html.match(/<dl[^>]*Quota windows[^>]*>[\s\S]*?<\/dl>/)?.[0] ?? "";
  expect(detail).not.toBe("");
  expect(detail).toContain(`<dt class="w-8 shrink-0 font-semibold">${translate("en", "limits.week")}</dt>`);
  const labels = [...detail.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]);
  expect(labels).not.toContain(translate("en", "limits.5h"));
  expect(detail).toContain("85%"); // 100 - 15, under the weekly label
});

test("dims and labels a stale account limits read and omits a missing reset time", () => {
  const html = render(base({
    accounts: [
      {
        id: "main", label: "Main", kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
        limits: { freshness: "stale", session: { usedPercent: 20, resetsAt: null, windowMinutes: 300 }, weekly: null },
      },
    ],
    active: "main",
  }));
  const detail = html.match(/<dl[^>]*Quota windows[^>]*>[\s\S]*?<\/dl>/)?.[0] ?? "";
  expect(detail).not.toBe("");
  // Freshness is a visible, AT-readable caption, not opacity/title alone.
  expect(detail).toContain("Last known values");
  expect(detail).toContain("opacity-70"); // values stay legible; text carries the meaning
  expect(html).toContain('title="Last known values — not a live read"');
  expect(detail).toContain("80%"); // 100 − 20 with no reset line
  expect(detail).not.toMatch(/reset (in|now)/); // resetsAt null → no reset-time text
});

test("automatic transcript migration controls stay outside the account panel", () => {
  const withAuto = render(base({ autoBalance: { enabled: true, thresholdPercent: 25, state: "idle", cooldownUntil: null, lastCheckAt: "2026-07-10T14:32:00.000Z", lastOutcome: null } }));
  expect(withAuto).not.toContain('role="switch"');
  expect(withAuto).not.toContain("Auto balance");
});

test("a switch mutation shows an accessible in-flight status", () => {
  const html = render(base({ mutation: "switch", active: "work" }));
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('role="status"');
  expect(html).toContain("Switching the account for future launches…");
});

test("the panel renders account buttons with no bare <select> switch control", () => {
  const html = render(base());
  expect(html).not.toContain("<select");
  expect(html).not.toContain("<option");
});

test("the active account row stays keyboard reachable", () => {
  const html = render(base());
  const active = html.match(/<button[^>]*aria-current="true"[^>]*>/)?.[0] ?? "";
  // React renders a disabled control as the bare `disabled=""` attribute; the
  // `disabled:` tailwind class variants in className are not the disabled state.
  expect(active).not.toContain('disabled=""');
});

test("shows removal only for a managed account and keeps cleanup reachable", () => {
  const html = render(base());
  expect(html).toContain('aria-label="Remove Work"');
  expect(html).not.toContain('aria-label="Remove Main"');
  expect(html).toContain("Clean up abandoned homes");
});

// ── Issue #61 — Claude login slice render coverage (Fable contract C12) ──────

const loginView = (over: Partial<ClaudeLoginView> = {}): ClaudeLoginView => ({
  operationId: "op1", phase: "awaiting_code", loginUrl: "https://claude.ai/login", acceptsCode: true,
  deadlineAt: "2026-07-10T12:00:00.000Z", result: null, ...over,
});
const claudeState = (login: ClaudeLoginView | null, over: Partial<EngineAccountsState> = {}): EngineAccountsState =>
  base({
    engine: "claude",
    active: "main",
    accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: false, loginPending: login != null, loginState: "pending", deviceAuth: null, login }],
    ...over,
  });

test("awaiting_code renders the browser link, bounded code input, hint, and Cancel", () => {
  const html = render(claudeState(loginView()));
  expect(html).toContain('href="https://claude.ai/login"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("noreferrer noopener");
  expect(html).toContain("Open claude.ai sign-in");
  expect(html).toContain('maxLength="8192"');
  expect(html).toContain("Paste the code from the browser"); // placeholder
  expect(html).toContain("After signing in, copy the code"); // hint
  expect(html).toContain('role="group"');
  expect(html).toContain("Acc sign-in"); // group aria-label
  // Empty code disables the submit; the Cancel affordance is present.
  expect(/<button[^>]*disabled[^>]*>Submit code<\/button>/.test(html)).toBeTrue();
  expect(html).toContain("Cancel");
});

test("starting and verifying show a spinner line, Cancel, and a hidden browser link", () => {
  const starting = render(claudeState(loginView({ phase: "starting", loginUrl: null, acceptsCode: false })));
  expect(starting).toContain("Starting sign-in…");
  expect(starting).toContain("animate-spin");
  expect(starting).not.toContain("Open claude.ai sign-in");
  expect(starting).not.toContain("claude.ai/login");
  const verifying = render(claudeState(loginView({ phase: "verifying", loginUrl: null, acceptsCode: false })));
  expect(verifying).toContain("Verifying…");
  expect(verifying).not.toContain("Open claude.ai sign-in");
  expect(verifying).toContain("Cancel");
});

test("canceling shows its spinner line with all actions withdrawn", () => {
  const html = render(claudeState(loginView({ phase: "canceling", loginUrl: null, acceptsCode: false })));
  expect(html).toContain("Canceling…");
  // Cancel is withdrawn in the canceling phase (nothing left to cancel).
  expect(/<button[^>]*>Cancel<\/button>/.test(html)).toBeFalse();
});

test("a terminal failure renders sanitized copy in an alert plus Retry and excludes raw detail", () => {
  const html = render(claudeState(loginView({ phase: "timed_out", loginUrl: null, acceptsCode: false, result: { status: "failure", code: "timed_out", message: "raw internal detail" } })));
  expect(html).toContain('role="alert"');
  expect(html).toContain("Sign-in timed out.");
  expect(html).not.toContain("raw internal detail"); // raw server detail stays absent
  expect(html).toContain("Retry");
});

test("an unknown failure code falls back to the generic sanitized line", () => {
  const html = render(claudeState(loginView({ phase: "failed", loginUrl: null, acceptsCode: false, result: { status: "failure", code: "persistence_failed", message: "secret path" } })));
  expect(html).toContain("Sign-in could not start. Try again.");
  expect(html).not.toContain("secret path");
});

test("a managed unauthenticated account with no live login offers Sign in", () => {
  const html = render(claudeState(null));
  expect(html).toContain("Sign in");
});

test("legacy Main stranded in signed_out or error gets an in-place recovery affordance (issue #470)", () => {
  // A signed-out legacy account offers Sign in — legacy is no longer excluded.
  const signedOut = render(claudeState(null, { accounts: [{ id: "default", label: "Main", kind: "legacy", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null, login: null }] }));
  expect(signedOut).toContain(">Sign in<");
  // A credentialed legacy account whose live auth is erroring offers Retry.
  const errored = render(claudeState(null, { accounts: [{ id: "default", label: "Main", kind: "legacy", authPresent: true, authHealth: "error", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }] }));
  expect(errored).toContain(">Retry<");
  // A healthy legacy account shows no recovery affordance.
  const healthy = render(claudeState(null, { accounts: [{ id: "default", label: "Main", kind: "legacy", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }] }));
  expect(healthy).not.toContain(">Sign in<");
  expect(healthy).not.toContain(">Retry<");
});

test("a managed account erroring with credentials present offers Retry in place (issue #470)", () => {
  const html = render(claudeState(null, { accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: true, authHealth: "error", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }] }));
  expect(html).toContain(">Retry<");
});

test("a live claude login disables the Add-account submit (no second sign-in races)", () => {
  const html = render(claudeState(loginView()));
  // The add form's submit ("Add") is disabled while a login is nonterminal.
  expect(/<button[^>]*type="submit"[^>]*disabled[^>]*>Add<\/button>/.test(html)).toBeTrue();
});

test("the panel carries one polite live region for sign-in announcements", () => {
  const html = render(claudeState(loginView()));
  expect(html).toContain('class="sr-only"');
  expect(html).toContain('aria-live="polite"');
});

test("uk-locale smoke: every new claude login key resolves and interpolates in Ukrainian", () => {
  expect(translate("uk", "accounts.claudeLoginStarted", { label: "Робочий" })).toBe("Вхід для Робочий розпочато");
  expect(translate("uk", "accounts.claudeLogin.openLink")).toBe("Відкрити вхід claude.ai");
  expect(translate("uk", "accounts.claudeLogin.codeHint")).toContain("claude.ai");
  expect(translate("uk", "accounts.claudeLogin.err.timed_out")).toBe("Час на вхід вичерпано.");
  expect(translate("uk", "accounts.claudeLogin.err.generic")).toBe("Не вдалося почати вхід. Спробуй ще раз.");
  expect(translate("uk", "accounts.claudeLogin.announceCodeReady", { label: "Робочий" })).toContain("Робочий");
  expect(translate("uk", "accounts.claudeLogin.announceCodeReady", { label: "Робочий" })).not.toContain("{label}");
});

test("a bound account carries no 'Bound to' chip in the dialog; the binding itself still travels (#1418)", () => {
  /* #1418: the chip carried nothing the operator acts on from this dialog.
     Project binding stays configurable where it lives; the card no longer
     spends a row on it, whether or not the account is bound. */
  const bound = render(base({
    accounts: [
      { id: "reserved", label: "Reserved", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
        projects: [{ project: "project-atlas", displayName: "Atlas" }] },
      { id: "spare", label: "Spare", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null },
    ],
    active: "reserved",
  }));
  expect(bound).not.toContain("data-account-projects");
  expect(bound).not.toContain("Bound to");
  expect(bound).not.toContain("Atlas");
  expect(bound).toContain("Reserved");
});

// ── Issues #1418 / #1373 / #1358 — the quiet card, reset credits, flagship row ─

const nowS = () => Math.floor(Date.now() / 1000);

test("the card is the quiet form: identity, status, one limits block with both actions, then the footer (#1418)", () => {
  const now = nowS();
  const resetsAt = now + 5 * 86_400;
  const html = render(base({
    accounts: [{
      id: "account-a", label: "Account A", kind: "managed", authPresent: true, authHealth: "authenticated", plan: "pro",
      loginPending: false, loginState: "authenticated", deviceAuth: null,
      limits: { freshness: "fresh", session: null, weekly: { usedPercent: 100, resetsAt, windowMinutes: 10_080 }, checkedAt: new Date((now - 60) * 1000).toISOString() },
      resetCredits: { availableCount: 1, expiresAt: now + 20 * 86_400 },
      projects: [{ project: "project-atlas", displayName: "Atlas" }],
    }],
    active: "account-a",
  }));
  const at = (needle: string) => {
    const index = html.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };
  // Identity line, then the limits block (check time, actions, windows), then the footer.
  expect(at(">Account A<")).toBeLessThan(at('data-account-limits="account-a"'));
  expect(at(translate("en", "accounts.limitsChecked"))).toBeLessThan(at('data-account-refresh-limits="account-a"'));
  expect(at('data-account-refresh-limits="account-a"')).toBeLessThan(at('data-limit-row="weekly"'));
  expect(at('data-limit-row="weekly"')).toBeLessThan(at('data-account-use-reset="account-a"'));
  expect(at('data-account-use-reset="account-a"')).toBeLessThan(at(translate("en", "accounts.copyCli")));
  expect(at(translate("en", "accounts.copyCli"))).toBeLessThan(at('aria-label="Remove Account A"'));
  // The exhausted state and its remedy read together.
  expect(html).toContain(translate("en", "rateLimit.badgeUntil", { time: formatResetClock(resetsAt, now) }));
  expect(html).toContain("1 reset available");
  expect(html).toContain(translate("en", "accounts.resetsExpire", { at: formatResetClock(now + 20 * 86_400, now) }));
  // No chip, and no confirmation copy anywhere near the two actions.
  expect(html).not.toContain("Bound to");
  expect(html).not.toContain("data-account-projects");
  expect(html).not.toContain(translate("en", "accounts.removeConfirmCta"));
  expect(html).toContain('aria-label="Re-read limits for Account A"');
  expect(html).toContain('aria-label="Use one usage-limit reset on Account A"');
});

function useResetButton(html: string, id: string): string {
  return html.match(new RegExp(`<button[^>]*data-account-use-reset="${id}"[^>]*>`))?.[0] ?? "";
}

test("the reset-credit line reads the count, none, or not-checked-yet, and the redeem control follows it (#1373)", () => {
  const row = (id: string, resetCredits: { availableCount: number; expiresAt: number | null } | null) => ({
    id, label: id, kind: "managed" as const, authPresent: true, loginPending: false, loginState: "authenticated" as const, deviceAuth: null,
    limits: { freshness: "fresh" as const, session: null, weekly: { usedPercent: 100, resetsAt: nowS() + 86_400, windowMinutes: 10_080 } },
    resetCredits,
  });
  const html = render(base({
    accounts: [row("one-credit", { availableCount: 1, expiresAt: null }), row("three-credits", { availableCount: 3, expiresAt: null }), row("spent", { availableCount: 0, expiresAt: null }), row("unread", null)],
    active: "one-credit",
  }));
  expect(html).toContain("1 reset available");
  expect(html).toContain("3 resets available");
  expect(html).toContain(translate("en", "accounts.resetsNone"));
  expect(html).toContain(translate("en", "accounts.resetsUnknown"));
  expect(useResetButton(html, "one-credit")).not.toContain('disabled=""');
  expect(useResetButton(html, "three-credits")).not.toContain('disabled=""');
  expect(useResetButton(html, "spent")).toContain('disabled=""');
  expect(useResetButton(html, "unread")).toContain('disabled=""');
});

test("Claude cards carry the refresh action but no reset-credit line; a signed-out account gets neither (#1418)", () => {
  const html = render(base({
    engine: "claude",
    accounts: [
      { id: "signed-in", label: "Signed in", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null,
        limits: { freshness: "fresh", session: { usedPercent: 10, resetsAt: null, windowMinutes: 300 }, weekly: null } },
      { id: "signed-out", label: "Signed out", kind: "managed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null },
    ],
    active: "signed-in",
  }));
  expect(html).toContain('data-account-refresh-limits="signed-in"');
  expect(html).not.toContain("data-account-use-reset");
  expect(html).not.toContain("data-account-reset-credits");
  expect(html).not.toContain('data-account-limits="signed-out"');
});

const claudeLimits = (flagship: number | null) => ({
  freshness: "fresh" as const,
  session: { usedPercent: 12, resetsAt: nowS() + 3_600, windowMinutes: 300 },
  weekly: { usedPercent: 40, resetsAt: nowS() + 4 * 86_400, windowMinutes: 10_080 },
  ...(flagship === null ? {} : { flagship: { usedPercent: flagship, resetsAt: nowS() + 4 * 86_400, windowMinutes: 10_080, tier: "opus" } }),
  checkedAt: new Date().toISOString(),
});
const claudeAccount = (flagship: number | null) => base({
  engine: "claude",
  accounts: [{ id: "account-a", label: "Account A", kind: "managed", authPresent: true, authHealth: "authenticated", plan: "max", loginPending: false, loginState: "authenticated", deviceAuth: null, limits: claudeLimits(flagship) }],
  active: "account-a",
});

test("no flagship bucket: two rows, no placeholder (#1358)", () => {
  const html = render(claudeAccount(null));
  expect(html).toContain('data-limit-row="session"');
  expect(html).toContain('data-limit-row="weekly"');
  expect(html).not.toContain('data-limit-row="flagship"');
  expect(html).not.toContain("Opus · Week");
  expect(html).toContain('title="weekly window binds"'); // 60% left on the week binds
  expect(html).toContain(">60%<");
});

test("a healthy flagship bucket renders as its own row named by the tier, and the general week still binds (#1358)", () => {
  const html = render(claudeAccount(10));
  const row = html.match(/<div[^>]*data-limit-row="flagship"[^>]*>[\s\S]*?<\/dd><\/div>/)?.[0] ?? "";
  expect(row).not.toBe("");
  expect(row).toContain(translate("en", "limits.tierWeek", { tier: "Opus" }));
  expect(row).toContain(">90%<");
  expect(row).toContain(translate("en", "limits.left"));
  expect(row).toContain("reset");
  expect(html).toContain('title="weekly window binds"');
  expect(html).toContain(">60%<");
});

test("a flagship bucket tighter than the general week binds the capacity chip (#1358)", () => {
  const html = render(claudeAccount(80));
  expect(html).toContain(translate("en", "limits.tierWeek", { tier: "Opus" }));
  expect(html).toContain(`title="${translate("en", "accounts.effectiveTip", { window: translate("en", "limits.windowFlagship", { tier: "Opus" }) })}"`);
  expect(html).toContain(">20%<");
});

test("uk-locale smoke: the new card strings resolve and interpolate", () => {
  expect(translate("uk", "accounts.resetsAvailable", { count: 1 })).toBe("1 скид доступний");
  expect(translate("uk", "accounts.resetsAvailable", { count: 3 })).toBe("3 скиди доступні");
  expect(translate("uk", "accounts.resetsAvailable", { count: 5 })).toBe("5 скидів доступно");
  expect(translate("uk", "accounts.useResetAria", { label: "Робочий" })).toContain("Робочий");
  expect(translate("uk", "accounts.refreshLimitsAria", { label: "Робочий" })).not.toContain("{label}");
  expect(translate("uk", "limits.tierWeek", { tier: "Opus" })).toBe("Opus · Тиждень");
});
