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
  expect(detail).toContain(translate("en", "limits.week"));
  expect(detail).not.toContain(translate("en", "limits.5h"));
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
  expect(detail).not.toContain(translate("en", "limits.5h"));
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
  expect(detail).not.toContain("reset"); // resetsAt null → no reset text
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

test("an account row names the projects it is bound to, and stays silent when it is bound to none (#1279)", () => {
  const bound = render(base({
    accounts: [
      { id: "reserved", label: "Reserved", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
        projects: [{ project: "project-atlas", displayName: "Atlas" }] },
      { id: "spare", label: "Spare", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null },
    ],
    active: "reserved",
  }));
  expect(bound).toContain('data-account-projects="reserved"');
  expect(bound).toContain("Atlas");
  expect(bound).toContain(translate("en", "accounts.boundProjects"));
  /* An account with no bindings is NOT restricted — a fenced-looking row there
     would say the opposite of what the record means. */
  expect(bound).not.toContain('data-account-projects="spare"');
});
