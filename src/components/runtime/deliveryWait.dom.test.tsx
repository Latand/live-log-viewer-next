/**
 * Issue #1213 — the composer says which wait this is.
 *
 * The operator saw one spinner for a delivery that took two seconds, one that
 * took twenty-one minutes and one that never arrived. These tests pin each of
 * those renderings, expanded and collapsed.
 *
 * Self-contained: the receipt stack is rendered directly, so nothing here mocks
 * a module, touches the runtime bus, or reads any state directory.
 */
import { expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { translate } from "@/lib/i18n";

import type { RuntimeReceipt } from "./runtimeModel";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

const { RuntimeComposerReceipts } = await import("@/components/TmuxComposer");
const { DELIVERY_UNCERTAIN_MS } = await import("./deliveryWait");

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const SUBMITTED_AT = "2026-08-27T10:00:00.000Z";
const at = (offsetMs: number) => Date.parse(SUBMITTED_AT) + offsetMs;

function receipt(overrides: Partial<RuntimeReceipt> = {}): RuntimeReceipt {
  return {
    operationId: "op-1213",
    idempotencyKey: "msg-1213",
    conversationId: "conversation_1213",
    kind: "send",
    status: "queued",
    text: "status of the merge queue",
    at: SUBMITTED_AT,
    admittedAt: SUBMITTED_AT,
    revision: 1,
    ...overrides,
  };
}

/** The host the operator was talking to: alive, and inside a turn. The composer
    may only describe a wait as a turn boundary on this evidence. */
const BUSY = { host: "hosted", turn: "running" } as const;

interface Mounted {
  host: HTMLElement;
  root: Root;
  status: () => string;
  cleanup: () => void;
}

function mount(node: React.ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  return {
    host,
    root,
    status: () => host.querySelector("[data-runtime-receipt-status]")?.textContent ?? "",
    cleanup: () => {
      act(() => { root.unmount(); });
      host.remove();
    },
  };
}

function open(host: HTMLElement): HTMLElement {
  const details = host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement;
  act(() => { details.open = true; details.dispatchEvent(new dom.Event("toggle") as unknown as Event); });
  return host.querySelector("[data-runtime-receipt-details]") as HTMLElement;
}

const noop = () => {};

/** Every button on the row, by its label — the row carries no control of its
    own past the ones the failure rendering always had. */
const buttonLabels = (scope: HTMLElement): string[] =>
  [...scope.querySelectorAll("button")].map((button) => button.textContent ?? "");

test("#1213 an attempt on the wire reads as transmitting and keeps its live pulse", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "delivering" })]}
      nowMs={at(4_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-status")).toBe("delivering");
  expect(chip.getAttribute("data-receipt-wait")).toBe("handing-over");
  expect(chip.textContent).toContain(t("runtime.receipt.delivering"));
  expect(details.querySelector(".animate-pulse")).not.toBeNull();
  view.cleanup();
});

test("#1213 a hand-over still running past the bound names itself", () => {
  /* The delivery queue writes `delivering` BEFORE `host.send`, so this message
     may be in front of the agent already and the queue owes it an outcome.
     Calling it undelivered would be false; going on spinning silently for
     twenty-one minutes is what the operator complained about. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "delivering" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("handing-over");
  expect(chip.textContent).toContain(t("runtime.receipt.handingOverFor", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  view.cleanup();
});

test("#1213 the composer's own unconfirmed row says so, and never claims a turn boundary", () => {
  /* `composer-unconfirmed:<key>` is the composer's local row for a send whose
     admission it never saw confirmed. «Waiting for the agent to finish its
     turn» would assert the very admission that is unknown. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ operationId: "composer-unconfirmed:msg-1213", status: "uncertain" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("unconfirmed-admission");
  expect(chip.textContent).toContain(t("runtime.receipt.admissionUnconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  expect(chip.textContent).not.toContain(t("runtime.receipt.awaitingTurnFor", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  expect(details.querySelector(".animate-pulse")).toBeNull();
  view.cleanup();
});

test("#1213 an admitted message waiting for a turn boundary says so, with the elapsed wait", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(4 * 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("awaiting-turn");
  expect(chip.textContent).toBe(t("runtime.receipt.awaitingTurnFor", {
    waited: t("runtime.receipt.waitedMin", { n: 4 }),
  }));
  /* The old rendering claimed transmission was under way. It is not: the
     message is journaled and parked until the agent's turn ends. */
  expect(chip.textContent).not.toContain(t("runtime.receipt.delivering"));
  expect(view.status()).toContain(t("runtime.receipt.awaitingTurnFor", {
    waited: t("runtime.receipt.waitedMin", { n: 4 }),
  }));
  view.cleanup();
});

test("#1213 a delivery unconfirmed past the bound is terminal and explains itself", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;

  expect(chip.getAttribute("data-receipt-wait")).toBe("uncertain");
  /* Says it was not delivered, and how long it waited. */
  expect(chip.textContent).toContain(t("runtime.receipt.unconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  /* Says why, and that sending it again is the only thing that moves it. */
  expect(details.querySelector("[data-receipt-uncertain-why]")?.textContent)
    .toBe(t("runtime.receipt.unconfirmedWhy"));
  /* Nothing on this row implies the message is still moving. */
  expect(details.querySelector(".animate-pulse")).toBeNull();
  expect(details.querySelector(".animate-spin")).toBeNull();
  /* And it offers no control of its own: the only exit that could act on the
     parked operation abandoned it and minted a replacement, which is how the
     same message reaches the agent twice. */
  expect(buttonLabels(details)).not.toContain(t("runtime.receipt.retry"));
  view.cleanup();
});

test("#1213 the collapsed summary already reads differently for a delivery that is not coming", () => {
  /* Collapsed is the default, and it is the surface the operator photographed:
     the same warning badge and the same spinner for a message arriving in two
     seconds and for one that never arrives. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const summary = view.host.querySelector("summary")!;
  expect(summary.querySelector("[data-receipt-problem-count]")).not.toBeNull();
  expect(summary.querySelector("[data-receipt-pending-count]")).toBeNull();
  expect(summary.textContent).toContain(t("runtime.receipt.problemCount", { count: 1 }));
  expect(view.host.querySelector(".animate-spin")).toBeNull();

  /* Inside the bound the same receipt is ordinary latency and reads as it did. */
  const healthy = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(2 * 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const healthySummary = healthy.host.querySelector("summary")!;
  expect(healthySummary.querySelector("[data-receipt-pending-count]")).not.toBeNull();
  expect(healthySummary.querySelector("[data-receipt-problem-count]")).toBeNull();
  healthy.cleanup();
  view.cleanup();
});

test("#1213 a delivery that never had a host says the window is gone in its terminal row too", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      session={{ host: "dead", turn: "unknown" }}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  /* The cause survives into the terminal row: telling the operator the agent
     "stayed inside a turn" when nothing was hosting the conversation at all
     sends them to look at the wrong thing. */
  expect(details.querySelector("[data-receipt-uncertain-why]")?.textContent)
    .toBe(t("runtime.receipt.unconfirmedWhyHost"));
  view.cleanup();
});

test("#1213 a delivery that lands late supersedes its own uncertain rendering", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "delivered", revision: 2 })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  /* A resolved delivery renders no chrome at all — the feed bubble is the
     receipt. The 21-minute success must not leave an "unconfirmed" row behind. */
  expect(view.host.querySelector("[data-runtime-receipt-stack]")).toBeNull();
  view.cleanup();
});

test("#1213 a genuinely failed delivery keeps its existing failure rendering and retry", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "failed", reason: "dead-host" })]}
      nowMs={at(30_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-status")).toBe("failed");
  expect(chip.getAttribute("data-receipt-wait")).toBeNull();
  expect(buttonLabels(details)).toContain(t("runtime.receipt.retry"));
  view.cleanup();
});

test("#1213 a delivery stranded by a dead host says the window is gone", () => {
  /* The deployment-rollback population: every structured host is terminated at
     once and each in-flight send is left `queued` with nothing hosting the
     conversation. The host's own axis is the authority — a message already
     `queued` when its host died keeps whatever reason it had, because the
     journal returns a same-status transition untouched, so the turn axis this
     row still carries must not win. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(3 * 60_000)}
      session={{ host: "dead", turn: "running" }}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("awaiting-host");
  expect(chip.textContent).toBe(t("runtime.receipt.awaitingHostFor", {
    waited: t("runtime.receipt.waitedMin", { n: 3 }),
  }));
  expect(chip.textContent).not.toContain(t("runtime.receipt.awaitingTurnFor", {
    waited: t("runtime.receipt.waitedMin", { n: 3 }),
  }));
  expect(details.querySelector(".animate-pulse")).toBeNull();
  view.cleanup();
});

test("#1213 the row measures the wait from the admission stamp the queue never rewrites", () => {
  /* The delivery queue bounces a parked send `delivering`→`queued` on every
     auto-retry, and the journal rewrites the receipt's `at` on each transition.
     Reading `at` restarts the clock every time: the elapsed label under-reports
     and the uncertain bound is never crossed, so the row that owns nothing goes
     on spinning — the exact defect this issue is about. */
  const bounced = receipt({
    status: "queued",
    admittedAt: SUBMITTED_AT,
    /* Rewritten twenty seconds ago by the latest bounce. */
    at: new Date(at(DELIVERY_UNCERTAIN_MS + 40_000)).toISOString(),
  });
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[bounced]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("uncertain");
  expect(chip.textContent).toContain(t("runtime.receipt.unconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  view.cleanup();
});

test("#1213 a parked message with no host behind it says it is waiting, without inventing a turn", () => {
  /* No structured session reached this surface, so nothing here knows whether
     a turn is running. The journal keeps a same-status transition as a no-op
     and the queue's dead-host branch writes a raw engine error, so the
     receipt's reason cannot answer it either — and «waiting for the agent to
     finish its turn» over a conversation nothing is hosting sends the operator
     to look at the wrong thing. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(3 * 60_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("awaiting-handover");
  expect(chip.textContent).toBe(t("runtime.receipt.awaitingHandoverFor", {
    waited: t("runtime.receipt.waitedMin", { n: 3 }),
  }));
  expect(chip.textContent).not.toContain(t("runtime.receipt.awaitingTurnFor", {
    waited: t("runtime.receipt.waitedMin", { n: 3 }),
  }));
  view.cleanup();
});

test("#1213 an unexplained wait carries an unexplained cause into its terminal row", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
    />,
  );
  const details = open(view.host);
  expect(details.querySelector("[data-receipt-uncertain-why]")?.textContent)
    .toBe(t("runtime.receipt.unconfirmedWhyUnknown"));
  view.cleanup();
});
