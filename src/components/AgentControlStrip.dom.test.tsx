import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";

import { AgentControlStripView } from "./AgentControlStrip";
import { capabilitiesFor } from "./agentCapabilities";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/c.jsonl", root: "claude-projects", name: "c.jsonl", project: "viewer", title: "c",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity: "idle", proc: null, pid: null, model: "sonnet", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function rv(hostKind: HostKind, host: HostAxis): RuntimeSessionView {
  return { session: { hostKind, host } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true };
}

function render(f: FileEntry, view: RuntimeSessionView | null, extra: Partial<Parameters<typeof AgentControlStripView>[0]> = {}) {
  const caps = capabilitiesFor(f, view);
  return renderToStaticMarkup(
    <AgentControlStripView
      t={t}
      isMobile={false}
      caps={caps}
      layout="full"
      compactArmed={false}
      stopBusy={false}
      compactBusy={false}
      overflowOpen={false}
      onStop={() => {}}
      onCompact={() => {}}
      onTerminal={() => {}}
      onToggleOverflow={() => {}}
      status={null}
      {...extra}
    />,
  );
}

test("live-root strip renders stop, compact, and terminal — no runtime selects (they moved to the composer pill)", () => {
  const html = render(file({ proc: "running" }), null);
  expect(html).toContain('data-strip-surface="live-root"');
  expect(html).toContain(`aria-label="${translate("en", "composer.interruptAria")}"`);
  // (the apostrophe in "the agent's context" is HTML-escaped in static markup)
  expect(html).toContain("context (/compact)");
  // Issue #390: the strip no longer hosts model/effort/Apply anywhere.
  expect(html).not.toContain("<select");
  expect(html).not.toContain(`>${translate("en", "runtimeConfig.apply")}<`);
});

test("hidden controls never reach the DOM (resume hides stop/compact/kill)", () => {
  const html = render(file({ proc: null }), null);
  expect(html).toContain('data-strip-surface="resume"');
  expect(html).not.toContain(translate("en", "composer.interruptAria"));
  // terminal keeps the resume strip alive; runtime lives in the composer pill
  expect(html).toContain(`aria-label="${translate("en", "attach.dialogTitle")}"`);
});

test("a disabled control keeps aria-disabled and appends the reason to its aria-label", () => {
  const html = render(file({ proc: "running" }), rv("codex-app-server", "hosted"));
  expect(html).toContain('data-strip-surface="structured"');
  // compact is disabled with the structured-fence reason appended to the aria-label
  const reason = translate("en", "strip.structuredUnsupported");
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain(`context (/compact) — ${reason}`);
});

test("the structured surface renders no mode chip — the «structured» badge is gone (issue #390)", () => {
  const structured = render(file({ proc: "running" }), rv("codex-app-server", "hosted"));
  expect(structured).not.toContain(">structured<");
  // Surfaces that carry routing information keep their chips.
  const resume = render(file({ proc: null }), null);
  expect(resume).toContain(`>${translate("en", "strip.resume")}<`);
});

test("mobile targets are 44px (h-11 w-11) and fold secondary controls behind overflow", () => {
  const caps = capabilitiesFor(file({ proc: "running" }), null);
  const html = renderToStaticMarkup(
    <AgentControlStripView
      t={t} isMobile caps={caps} layout="full"
      compactArmed={false} stopBusy={false} compactBusy={false} overflowOpen={false}
      onStop={() => {}} onCompact={() => {}} onTerminal={() => {}} onToggleOverflow={() => {}} status={null}
    />,
  );
  expect(html).toContain("h-11 w-11");
  // on mobile the overflow disclosure appears (compact/terminal fold away)
  expect(html).toContain(`aria-label="${translate("en", "strip.moreActions")}"`);
  expect(html).toContain('aria-expanded="false"');
});

test("busy stop swaps to a spinner and disables in place", () => {
  const html = render(file({ proc: "running" }), null, { stopBusy: true });
  expect(html).toContain("animate-spin");
  expect(html).toContain("disabled");
});

test("narrow layout folds compact/terminal behind the overflow; opening it reveals them", () => {
  const openHtml = render(file({ proc: "running" }), null, { layout: "narrow", overflowOpen: true });
  expect(openHtml).toContain('data-strip-layout="narrow"');
  expect(openHtml).toContain("context (/compact)");
  expect(openHtml).toContain('aria-expanded="true"');
});

test("the status line is a polite live region for ok/info and assertive for errors", () => {
  const ok = render(file({ proc: "running" }), null, { status: { kind: "ok", text: "sent" } });
  expect(ok).toContain('aria-live="polite"');
  const err = render(file({ proc: "running" }), null, { status: { kind: "err", text: "boom" } });
  expect(err).toContain('aria-live="assertive"');
});
