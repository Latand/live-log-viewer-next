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
  select: async () => true,
  add: async () => true,
  retryNotice: async () => true,
  preview: async () => null,
  selectAndMigrate: async () => true,
  stopMigration: async () => true,
  setAutoBalance: async () => true,
  ...over,
});

const render = (state: EngineAccountsState) => renderToStaticMarkup(<AccountsPanel state={state} onClose={() => {}} />);

test("titles the panel per engine and keeps the mobile-only backdrop before the dialog", () => {
  expect(render(base())).toContain("Codex accounts");
  expect(render(base({ engine: "claude" }))).toContain("Claude accounts");
  const html = render(base());
  expect(html.indexOf("sm:hidden")).toBeLessThan(html.indexOf('role="dialog"'));
  expect(html.match(/role="dialog"/g)?.length).toBe(1);
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

test("a completed migration shows the settle notice instead of the progress row", () => {
  const html = render(base({
    migration: { intentId: "i1", targetId: "work", targetLabel: "Work", revision: 1, origin: "manual", reason: null, state: "complete", counts: { done: 7, waitingTurn: 0, inFlight: 0, failed: 0, total: 7 }, startedAt: null },
  }));
  expect(html).toContain("All Codex sessions now on «Work»");
  expect(html).not.toContain("Stop migration");
});
