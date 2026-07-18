import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "./runtimeModel";

import { DeadHostBannerView, isDeadHostSession } from "./DeadHostBanner";
import { AttentionCard } from "./AttentionCard";
import type { RuntimeAttention } from "./runtimeModel";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

function rv(hostKind: HostKind, host: HostAxis, legacy = false): RuntimeSessionView {
  return { session: { hostKind, host } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy, structuredControlsEnabled: true };
}

/* ------------------------------ isDeadHostSession ------------------------------ */

test("only a dead or unhosted axis raises the banner; legacy and live never do", () => {
  expect(isDeadHostSession(rv("claude-broker", "dead"))).toBe(true);
  expect(isDeadHostSession(rv("codex-app-server", "unhosted"))).toBe(true);
  expect(isDeadHostSession(rv("codex-app-server", "hosted"))).toBe(false);
  expect(isDeadHostSession(rv("tmux-legacy", "dead", true))).toBe(false);
  expect(isDeadHostSession(null)).toBe(false);
});

/* ------------------------------ banner view ------------------------------ */

test("the banner states what died and when, as a polite status, with the danger tone", () => {
  const html = renderToStaticMarkup(
    <DeadHostBannerView t={t} sinceLabel="12 min" onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain("data-dead-host-banner");
  expect(html).toContain("border-danger/45");
  expect(html).toContain(translate("en", "deadHost.title", { since: "12 min" }));
  // (the apostrophe in "can't" is HTML-escaped in static markup)
  expect(html).toContain("Pending approvals expired.");
  expect(html).toContain(translate("en", "deadHost.respawn"));
  expect(html).toContain(translate("en", "deadHost.attach"));
  expect(html).toContain(translate("en", "deadHost.recheck"));
});

test("the fmtAge since label keeps a single localized ago/тому suffix (#380)", () => {
  // The container passes fmtAge(file.mtime), whose output already ends in the
  // localized suffix — the title template must not append it a second time.
  for (const locale of ["en", "uk"] as const) {
    const tLoc: typeof t = (key, params) => translate(locale, key, params);
    const since = translate(locale, "time.agoMin", { n: 12 });
    const html = renderToStaticMarkup(
      <DeadHostBannerView t={tLoc} sinceLabel={since} onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} />,
    );
    expect(html).toContain(translate(locale, "deadHost.title", { since }));
    const suffix = locale === "en" ? "ago" : "тому";
    expect(html.split(suffix).length - 1).toBe(1);
  }
});

test("respawn shows a spinner and disables while busy", () => {
  const html = renderToStaticMarkup(
    <DeadHostBannerView t={t} sinceLabel="1 min" onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} respawnBusy />,
  );
  expect(html).toContain("animate-spin");
});

test("a failed Re-check is surfaced as an alert, not swallowed (§5, finding 5)", () => {
  const html = renderToStaticMarkup(
    <DeadHostBannerView t={t} sinceLabel="1 min" onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} recheckError="Couldn't reach the runtime — try again." />,
  );
  expect(html).toContain('role="alert"');
  // (the apostrophe in "Couldn't" is HTML-escaped in static markup)
  expect(html).toContain("reach the runtime — try again.");
});

test("banner action buttons meet the 44px mobile target", () => {
  const html = renderToStaticMarkup(
    <DeadHostBannerView t={t} sinceLabel="1 min" onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} />,
  );
  expect(html.match(/min-h-11/g)?.length).toBe(3);
});

/* ------------------------- archived attention cards (§5) ------------------------- */

function attention(overrides: Partial<RuntimeAttention> = {}): RuntimeAttention {
  return {
    id: "att_1", conversationId: "conv_a", kind: "approval", state: "open", unowned: false,
    createdAt: "2026-07-10T00:00:00.000Z", request: { command: "rm -rf build" },
    ...overrides,
  };
}

test("an archived attention card is dimmed, keeps the question, but removes the buttons", () => {
  const html = renderToStaticMarkup(
    <AttentionCard attention={attention()} onApprove={() => {}} onDeny={() => {}} archived />,
  );
  expect(html).toContain('data-attention-archived="true"');
  expect(html).toContain("opacity-60 saturate-50");
  // the request stays visible as history
  expect(html).toContain("rm -rf build");
  // …but the actionable buttons are gone (not merely disabled)
  expect(html).not.toContain(translate("en", "runtime.attention.approve"));
  expect(html).not.toContain(translate("en", "runtime.attention.deny"));
  // and the one-line expired caption is shown
  expect(html).toContain(translate("en", "deadHost.expiredCard"));
});

test("a live attention card still renders its approve/deny buttons", () => {
  const html = renderToStaticMarkup(<AttentionCard attention={attention()} onApprove={() => {}} onDeny={() => {}} />);
  expect(html).toContain(translate("en", "runtime.attention.approve"));
  expect(html).not.toContain(translate("en", "deadHost.expiredCard"));
});
