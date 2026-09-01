import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { LimitsPayload } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.Event,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const NOW = Math.round(Date.now() / 1000);

let limits: LimitsPayload;
let limitsUnavailable = false;
const baseAccount = {
  id: "account-a",
  label: "Account A",
  kind: "managed",
  authPresent: true,
  auth: { state: "authenticated" },
  loginPending: false,
  loginState: "authenticated",
  deviceAuth: null,
  effective: { percent: 79, window: "weekly", freshness: "fresh" },
  limits: {
    state: "fresh",
    session: null,
    weekly: { usedPercent: 21, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 },
    checkedAt: new Date((NOW - 60) * 1000).toISOString(),
  },
};
const accounts = {
  codex: { active: "account-a", accounts: [baseAccount] },
  claude: { active: "claude-a", accounts: [] },
};

// The singleton account stores resolve the active global fetch at request time,
// so this lifecycle-owned stub remains valid regardless of import order.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === "/api/limits") return limitsUnavailable ? new Response(null, { status: 503 }) : Response.json(limits);
  if (url === "/api/accounts") return Response.json(accounts);
  return new Response(null, { status: 404 });
}) as unknown as typeof fetch;

const { LimitsFooter, fmtQuotaStaleHint } = await import("./LimitsFooter");

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  accounts.codex.accounts = [baseAccount];
  limitsUnavailable = false;
  setSystemTime();
});

async function render(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<LimitsFooter />);
  });
  // One more turn for the limits and accounts responses to land.
  await act(async () => { await Promise.resolve(); });
  return host;
}

test("a weekly-horizon Codex window is labelled Week in the footer, never 5h", async () => {
  // The production shape of #606: the only window the plan reports is a weekly
  // one, and it arrives in the session field. The footer row must be named by
  // the horizon the number carries.
  limits = {
    claude: null,
    codex: { session: { usedPercent: 15, resetsAt: NOW + 437_631, windowMinutes: 10_080 }, weekly: null, plan: "pro", capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "live", reason: null, staleSince: null },
    },
    staleSince: null,
  };
  const host = await render();
  const text = host.textContent ?? "";
  expect(text).toContain("Week");
  expect(text).not.toContain("5h");
  expect(text).toContain("85%"); // 100 − 15 remaining, under the weekly label
});

test("a genuine 5-hour window keeps the 5h label", async () => {
  limits = {
    claude: null,
    codex: { session: { usedPercent: 40, resetsAt: NOW + 3_600, windowMinutes: 300 }, weekly: { usedPercent: 10, resetsAt: NOW + 172_800, windowMinutes: 10_080 }, plan: "pro", capturedAt: NOW },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "live", reason: null, staleSince: null },
    },
    staleSince: null,
  };
  const host = await render();
  const text = host.textContent ?? "";
  expect(text).toContain("5h");
  expect(text).toContain("Week");
});

test("provider exhaustion reconciles the header chip and weekly row to zero", async () => {
  accounts.codex.accounts = [{
    ...baseAccount,
    effective: { percent: 79, window: "weekly", freshness: "fresh" },
    limits: {
      state: "fresh",
      session: null,
      weekly: { usedPercent: 21, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 },
      checkedAt: new Date((NOW - 60) * 1000).toISOString(),
    },
  }];
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 600 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render();
  const text = host.textContent ?? "";
  expect(text).not.toContain("79%");
  expect(text.match(/0%/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

  const trigger = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Codex"));
  expect(trigger).toBeDefined();
  await act(async () => { trigger?.click(); });
  const dialog = host.querySelector('[role="dialog"][aria-label*="Codex"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).not.toContain("79%");
  expect(dialog?.textContent).toContain("0%");
});

test("a stale reconciled number renders a visible as-of hint", async () => {
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 30 * 60 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render();
  expect(host.textContent).toContain("as of");
});

test("timestamp-less stale footer rows retain a visible last-known label", () => {
  expect(fmtQuotaStaleHint(true, null, "en")).toBe("Last known values");
  expect(fmtQuotaStaleHint(false, null, "en")).toBeNull();
});

test("failed polls still advance stale age and expired-exhaustion selection", async () => {
  const realSetInterval = globalThis.setInterval;
  let poll: (() => Promise<void>) | null = null;
  globalThis.setInterval = ((handler: TimerHandler) => {
    poll = handler as () => Promise<void>;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  setSystemTime(new Date(NOW * 1000));
  limits = {
    claude: null,
    codex: {
      session: { usedPercent: 50, resetsAt: NOW + 3_600, windowMinutes: 300, observedAt: NOW - 19 * 60 },
      weekly: { usedPercent: 100, resetsAt: NOW + 30, windowMinutes: 10_080, observedAt: NOW - 19 * 60 },
      plan: "prolite",
      capturedAt: NOW - 19 * 60,
    },
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  try {
    const host = await render();
    expect(host.textContent).toContain("0%");
    expect(host.textContent).not.toContain("as of");

    limitsUnavailable = true;
    setSystemTime(new Date((NOW + 120) * 1000));
    await act(async () => { await poll?.(); });

    expect(host.textContent).toContain("79%");
    expect(host.textContent).toContain("as of");
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("failed polls retain the original receipt time for timestamp-less Claude windows", async () => {
  const realSetInterval = globalThis.setInterval;
  let poll: (() => Promise<void>) | null = null;
  globalThis.setInterval = ((handler: TimerHandler) => {
    poll = handler as () => Promise<void>;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  setSystemTime(new Date(NOW * 1000));
  limits = {
    claude: {
      session: { usedPercent: 50, resetsAt: NOW + 3_600, windowMinutes: 300 },
      weekly: null,
      plan: "max",
      capturedAt: null,
    },
    codex: null,
    claudeAccountId: "claude-a",
    codexAccountId: "account-a",
    provenance: {
      claude: { source: "live", reason: null, staleSince: null },
      codex: { source: "unavailable", reason: null, staleSince: null },
    },
  };

  try {
    const host = await render();
    const trigger = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Claude"));
    const block = trigger?.closest("div.relative");
    expect(block?.textContent).not.toContain("as of");

    limitsUnavailable = true;
    setSystemTime(new Date((NOW + 21 * 60) * 1000));
    await act(async () => { await poll?.(); });

    expect(block?.textContent).toContain("as of");
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test("an account B limits payload cannot override account A at the rendering seam", async () => {
  limits = {
    claude: null,
    codex: { session: null, weekly: { usedPercent: 100, resetsAt: NOW + 6 * 86_400, windowMinutes: 10_080 }, plan: "prolite", capturedAt: NOW - 60 },
    claudeAccountId: "claude-a",
    codexAccountId: "account-b",
    provenance: {
      claude: { source: "unavailable", reason: null, staleSince: null },
      codex: { source: "transcript", reason: "transcript-reconciled", staleSince: null },
    },
  };

  const host = await render();
  const text = host.textContent ?? "";
  expect(text).toContain("79%");
  expect(text).not.toContain("0%");
});

// ── Issue #1358 — the flagship tier's weekly as its own footer row ───────────

const claudePayload = (flagship: number | null): LimitsPayload => ({
  claude: {
    session: { usedPercent: 12, resetsAt: NOW + 3_600, windowMinutes: 300 },
    weekly: { usedPercent: 40, resetsAt: NOW + 4 * 86_400, windowMinutes: 10_080 },
    ...(flagship === null ? {} : { flagship: { usedPercent: flagship, resetsAt: NOW + 4 * 86_400, windowMinutes: 10_080, tier: "opus" } }),
    plan: "max",
    capturedAt: NOW,
  },
  codex: null,
  claudeAccountId: "claude-a",
  codexAccountId: "account-a",
  provenance: {
    claude: { source: "live", reason: null, staleSince: null },
    codex: { source: "unavailable", reason: null, staleSince: null },
  },
  staleSince: null,
});

function claudeBlock(host: HTMLElement): HTMLElement {
  const trigger = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Claude"));
  return trigger!.closest("div.relative") as HTMLElement;
}

test("no flagship bucket: the Claude block keeps its two rows and no placeholder", async () => {
  limits = claudePayload(null);
  const block = claudeBlock(await render());
  expect(block.textContent).toContain("5h");
  expect(block.textContent).toContain("Week");
  expect(block.textContent).not.toContain("Opus · Week");
  expect(block.textContent).toContain("60%"); // the general week binds the chip
});

test("a healthy flagship bucket renders as a third row named by the tier, and the general week still binds the chip", async () => {
  limits = claudePayload(10);
  const block = claudeBlock(await render());
  expect(block.textContent).toContain("Opus · Week");
  expect(block.textContent).toContain("90%");
  expect(block.textContent).toContain("60%");
  expect(block.textContent?.match(/reset/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
});

test("a flagship bucket tighter than the general week binds the chip", async () => {
  limits = claudePayload(80);
  const block = claudeBlock(await render());
  expect(block.textContent).toContain("Opus · Week");
  const chip = block.querySelector("span.tabular-nums");
  expect(chip?.textContent).toBe("20%");
});
