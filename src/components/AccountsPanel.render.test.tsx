import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ClaudeLoginView, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { translate } from "@/lib/i18n";

import { AccountsPanel } from "./AccountsPanel";

const base = (over: Partial<EngineAccountsState> = {}): EngineAccountsState => ({
  engine: "codex",
  accounts: [
    { id: "main", label: "Main", kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, effective: { percent: 12, window: "session", freshness: "fresh" } },
    { id: "work", label: "Work", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, effective: { percent: 64, window: "weekly", freshness: "stale" } },
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
  ...over,
});

const render = (state: EngineAccountsState, placement?: "footer" | "header") =>
  renderToStaticMarkup(<AccountsPanel state={state} onClose={() => {}} placement={placement} />);

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
  expect(html).toContain("opacity-55"); // the stale Work chip
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
  // A legacy account never gets the managed sign-in affordance.
  const legacy = render(claudeState(null, { accounts: [{ id: "acc", label: "Acc", kind: "legacy", authPresent: false, loginPending: false, loginState: "idle", deviceAuth: null, login: null }] }));
  expect(legacy).not.toContain(">Sign in<");
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
