import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { EngineAccountsState } from "@/hooks/useEngineAccounts";

import { AccountsPanel } from "./AccountsPanel";

const base = (over: Partial<EngineAccountsState> = {}): EngineAccountsState => ({
  engine: "codex",
  accounts: [
    { id: "main", label: "Main", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, effective: { percent: 12, window: "session", freshness: "fresh" } },
    { id: "work", label: "Work", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, effective: { percent: 64, window: "weekly", freshness: "stale" } },
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
  preview: async () => null,
  selectAndMigrate: async () => true,
  stopMigration: async () => true,
  retryFailedMigration: async () => true,
  setAutoBalance: async () => true,
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

test("the auto-balance switch appears only when the coordinator advertises it", () => {
  expect(render(base())).not.toContain('role="switch"');
  const withAuto = render(base({ autoBalance: { enabled: true, thresholdPercent: 25, state: "idle", cooldownUntil: null, lastCheckAt: "2026-07-10T14:32:00.000Z", lastOutcome: null } }));
  expect(withAuto).toContain('role="switch"');
  expect(withAuto).toContain('aria-checked="true"');
  expect(withAuto).toContain("Auto balance");
});

test("a draining migration shows a polite banner with counts and Stop", () => {
  const html = render(base({
    migration: { intentId: "i1", targetId: "work", targetLabel: "Work", revision: 1, origin: "auto", reason: null, state: "draining", counts: { done: 4, waitingTurn: 2, inFlight: 1, failed: 1, total: 7 }, startedAt: null },
    autoBalance: { enabled: true, thresholdPercent: 25, state: "draining", cooldownUntil: null, lastCheckAt: null, lastOutcome: null },
  }));
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("Migrating to «Work» — 4/7 done");
  expect(html).toContain("2 waiting on turns");
  expect(html).toContain("1 failed");
  expect(html).toContain("Stop migration");
  expect(html).toContain("Auto"); // origin tag
});

test("the panel renders account buttons with no bare <select> switch control", () => {
  const html = render(base());
  expect(html).not.toContain("<select");
  // Each account is a real button (preview → confirm/migrate), never an <option>.
  expect(html).not.toContain("<option");
});

test("the active account row stays clickable so a same-active repair can run", () => {
  const html = render(base());
  // The active row carries aria-current and must not be disabled: clicking it
  // previews and can launch a zero-scope, revision-fenced repair migration.
  const active = html.match(/<button[^>]*aria-current="true"[^>]*>/)?.[0] ?? "";
  // React renders a disabled control as the bare `disabled=""` attribute; the
  // `disabled:` tailwind class variants in className are not the disabled state.
  expect(active).not.toContain('disabled=""');
});

test("a draining migration with failures offers a Retry-failed affordance", () => {
  const html = render(base({
    migration: { intentId: "i1", targetId: "work", targetLabel: "Work", revision: 2, origin: "manual", reason: null, state: "draining", counts: { done: 3, waitingTurn: 0, inFlight: 1, failed: 2, total: 6 }, startedAt: null },
  }));
  expect(html).toContain("Retry failed (2)");
  expect(html).toContain("Stop migration");
});

test("a draining migration with no failures hides the Retry-failed button", () => {
  const html = render(base({
    migration: { intentId: "i1", targetId: "work", targetLabel: "Work", revision: 2, origin: "manual", reason: null, state: "draining", counts: { done: 5, waitingTurn: 1, inFlight: 0, failed: 0, total: 6 }, startedAt: null },
  }));
  expect(html).not.toContain("Retry failed");
});

test("a completed migration with no failures shows the settle notice and no progress row", () => {
  const html = render(base({
    migration: { intentId: "i1", targetId: "work", targetLabel: "Work", revision: 1, origin: "manual", reason: null, state: "complete", counts: { done: 7, waitingTurn: 0, inFlight: 0, failed: 0, total: 7 }, startedAt: null },
  }));
  expect(html).toContain("All Codex sessions now on «Work»");
  expect(html).not.toContain("Stop migration");
  expect(html).not.toContain("Retry failed");
});

test("a terminal migration that still has failures keeps the bulk Retry-failed control", () => {
  // Terra's projection retains a `complete` intent while any conversation is
  // failed-recoverable (counts.failed stays positive). The banner drops Stop but
  // keeps the bulk retry so terminal recoverable failures remain recoverable.
  const html = render(base({
    migration: { intentId: "i1", targetId: "work", targetLabel: "Work", revision: 4, origin: "manual", reason: null, state: "complete", counts: { done: 5, waitingTurn: 0, inFlight: 0, failed: 2, total: 7 }, startedAt: null },
  }));
  expect(html).toContain("Retry failed (2)");
  expect(html).not.toContain("Stop migration");
  // The misleading "all sessions moved" settle line is suppressed while failures remain.
  expect(html).not.toContain("All Codex sessions now on «Work»");
});
