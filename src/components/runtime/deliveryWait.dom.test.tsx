/**
 * Issue #1213 — the composer says which wait this is.
 *
 * The operator saw one spinner for a delivery that took two seconds, one that
 * took twenty-one minutes and one that never arrived. These tests pin every
 * rendering and the exit the uncertain one now carries.
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

const { RuntimeComposerReceipts, runtimeOperationActionResult, runtimeRetryRequestInit } = await import("@/components/TmuxComposer");
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
  expect(details.querySelector("[data-receipt-discard]")).toBeNull();
  view.cleanup();
});

test("#1213 a hand-over still running past the bound explains itself and offers no exit", () => {
  /* The duplicate-delivery fence, on the rendering side: the delivery queue
     writes `delivering` BEFORE `host.send`, so this message may be in front of
     the agent already. Failing it here would retire its effect mid-flight and
     let a replacement deliver the same message twice, which is why the server
     refuses — and why the row must not advertise a control that would be. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "delivering" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("handing-over");
  expect(chip.textContent).toContain(t("runtime.receipt.handingOverFor", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  expect(details.querySelector("[data-receipt-uncertain-retry]")).toBeNull();
  expect(details.querySelector("[data-receipt-discard]")).toBeNull();
  view.cleanup();
});

test("#1213 the composer's own unconfirmed row says so, and carries no server control", () => {
  /* `composer-unconfirmed:<key>` names no journal operation. Retry and Discard
     would 400 on the colon alone, and there may be nothing on the server to
     abandon — the composer already released the draft for a same-key resend. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ operationId: "composer-unconfirmed:msg-1213", status: "uncertain" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
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
  expect(details.querySelector("[data-receipt-uncertain-retry]")).toBeNull();
  expect(details.querySelector("[data-receipt-discard]")).toBeNull();
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

test("#1213 a delivery unconfirmed past the bound is terminal, explains itself, and offers an exit", () => {
  const retried: string[] = [];
  const discarded: string[] = [];
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      session={BUSY}
      onRetry={(item) => retried.push(item.operationId)}
      onEdit={noop}
      onDiscard={(item) => discarded.push(item.operationId)}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;

  expect(chip.getAttribute("data-receipt-wait")).toBe("uncertain");
  /* Says it was not delivered, and how long it waited. */
  expect(chip.textContent).toContain(t("runtime.receipt.unconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  /* Says why. */
  expect(details.textContent).toContain(t("runtime.receipt.unconfirmedWhy"));
  /* Nothing on this row implies the message is still moving. */
  expect(details.querySelector(".animate-pulse")).toBeNull();
  expect(details.querySelector(".animate-spin")).toBeNull();

  const retry = details.querySelector("[data-receipt-uncertain-retry]") as HTMLButtonElement;
  const discard = details.querySelector("[data-receipt-discard]") as HTMLButtonElement;
  expect(retry.textContent).toBe(t("runtime.receipt.retry"));
  expect(discard.getAttribute("aria-label")).toBe(t("runtime.receipt.discard"));
  act(() => { retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  act(() => { discard.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  expect(retried).toEqual(["op-1213"]);
  expect(discarded).toEqual(["op-1213"]);
  view.cleanup();
});

test("#1213 the collapsed summary already reads differently for a delivery that is not coming", () => {
  /* Collapsed is the default, and it is the surface the operator photographed:
     the same warning badge and the same spinner for a message arriving in two
     seconds and for one that never arrives. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued", reason: "busy-turn" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
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
      receipts={[receipt({ status: "queued", reason: "busy-turn" })]}
      nowMs={at(2 * 60_000)}
      session={BUSY}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
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
      receipts={[receipt({ status: "queued", reason: "dead-host" })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  /* The cause survives into the terminal row: telling the operator the agent
     "stayed inside a turn" when nothing was hosting the conversation at all
     sends them to look at the wrong thing. */
  expect(details.querySelector("[data-receipt-uncertain-why]")?.textContent)
    .toBe(t("runtime.receipt.unconfirmedWhyHost"));
  expect(details.querySelector("[data-receipt-discard]")).not.toBeNull();
  view.cleanup();
});

test("#1213 a delivery that lands late supersedes its own uncertain rendering", () => {
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "delivered", revision: 2 })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
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
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-status")).toBe("failed");
  expect(chip.getAttribute("data-receipt-wait")).toBeNull();
  expect(details.querySelector("[data-receipt-uncertain-retry]")).toBeNull();
  view.cleanup();
});

test("#1213 retrying an unconfirmed delivery asks the server to abandon it first", () => {
  /* The linchpin of "a retry cannot duplicate an already-delivered message":
     the parked attempt is terminalized — and its durable effect retired — in
     the same server step that mints the replacement. */
  const unconfirmed = runtimeRetryRequestInit(receipt({ status: "queued" }));
  expect(unconfirmed.method).toBe("POST");
  expect(JSON.parse(String(unconfirmed.body))).toEqual({ abandonUnconfirmed: true });

  /* A terminal failure has nothing left to abandon and retries as it always did. */
  const failed = runtimeRetryRequestInit(receipt({ status: "failed", reason: "dead-host" }));
  expect(failed.body).toBeUndefined();
});

test("#1213 a refusal to abandon a hand-over is read as itself, not as a failure or a success", () => {
  /* The server answers 409 with the live receipt when the message is already
     being put in front of the agent. Reading that as an ordinary failure would
     print «could not send» over a message that is arriving; reading it as a
     success would tell the operator it was discarded when nothing was. */
  const live = { operationId: "op-1213", status: "delivering" } as unknown as RuntimeReceipt;
  expect(runtimeOperationActionResult({ handover: true, receipt: live, error: "handed over" }, false))
    .toEqual({ kind: "handover", receipt: live });

  /* And the two ordinary answers keep reading as they did. */
  expect(runtimeOperationActionResult({ receipt: live }, true)).toEqual({ kind: "applied", receipt: live });
  expect(runtimeOperationActionResult({ error: "operation not found" }, false))
    .toEqual({ kind: "error", error: "operation not found" });
});

test("#1213 a delivery stranded by a dead host says the window is gone, not that a turn is running", () => {
  /* The deployment-rollback population: every structured host is terminated at
     once and each in-flight send is left `queued` with a `dead-host` reason. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued", reason: "dead-host" })]}
      nowMs={at(3 * 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("awaiting-host");
  expect(chip.textContent).toBe(t("runtime.receipt.awaitingHostFor", {
    waited: t("runtime.receipt.waitedMin", { n: 3 }),
  }));
  /* And the reason itself, in human words, beside it. */
  expect(details.querySelector("[data-receipt-host-gone]")?.textContent)
    .toBe(t("receipt.human.deadHost"));
  expect(details.querySelector(".animate-pulse")).toBeNull();
  view.cleanup();
});

test("#1213 the row measures the wait from the admission, not from a receipt stamp the queue keeps moving", () => {
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
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("uncertain");
  expect(chip.textContent).toContain(t("runtime.receipt.unconfirmed", {
    waited: t("runtime.receipt.waitedMin", { n: 21 }),
  }));
  expect(details.querySelector("[data-receipt-discard]")).not.toBeNull();
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
      receipts={[receipt({ status: "queued", reason: null })]}
      nowMs={at(3 * 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
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
      receipts={[receipt({ status: "queued", reason: null })]}
      nowMs={at(DELIVERY_UNCERTAIN_MS + 60_000)}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  expect(details.querySelector("[data-receipt-uncertain-why]")?.textContent)
    .toBe(t("runtime.receipt.unconfirmedWhyUnknown"));
  expect(details.querySelector("[data-receipt-discard]")).not.toBeNull();
  view.cleanup();
});

test("#1213 the host's own axis outranks a reason the journal never updated", () => {
  /* A message already `queued` when its host died keeps whatever reason it had:
     the journal returns a same-status transition untouched, so the `dead-host`
     the queue tried to write never landed. The live host axis is the thing that
     knows, and it is what the row reads. */
  const view = mount(
    <RuntimeComposerReceipts
      receipts={[receipt({ status: "queued", reason: null })]}
      nowMs={at(3 * 60_000)}
      session={{ host: "dead", turn: "running" }}
      onRetry={noop}
      onEdit={noop}
      onDiscard={noop}
    />,
  );
  const details = open(view.host);
  const chip = details.querySelector("[data-receipt-status]")!;
  expect(chip.getAttribute("data-receipt-wait")).toBe("awaiting-host");
  expect(chip.textContent).toBe(t("runtime.receipt.awaitingHostFor", {
    waited: t("runtime.receipt.waitedMin", { n: 3 }),
  }));
  /* And no invented reason beside it: the receipt never recorded one, so the
     row says the window is gone and stops there rather than printing the
     generic failure text over a message that has not failed. */
  expect(details.querySelector("[data-receipt-host-gone]")).toBeNull();
  view.cleanup();
});
