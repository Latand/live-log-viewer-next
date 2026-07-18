import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";

import { appendComposerDraft, mergeRuntimeReceipts, RuntimeComposerReceipts, TmuxComposer } from "./TmuxComposer";

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
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

/** Render into a fresh root, flushing mount effects (target poll) inside act. */
async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

/** Run a DOM interaction and let its async state updates settle inside act. */
const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
};

function expectAccessibleBusyFeedback(host: HTMLElement, locale: "en" | "uk") {
  // The collapsed summary announces busy-retry accessibly: the pending badge
  // carries the wording in its label/title beside a visible spinner, and the
  // live status region repeats it for screen readers.
  const summary = host.querySelector("summary")!;
  const pending = summary.querySelector("[data-receipt-pending-count]")!;
  expect(pending.getAttribute("aria-label")).toBe(
    `${translate(locale, "runtime.receipt.pendingCount", { count: 1 })} · ${translate(locale, "runtime.receipt.busyRetry")}`,
  );
  expect(pending.getAttribute("title")).toBe(translate(locale, "runtime.receipt.busyRetry"));
  expect(pending.querySelector(".animate-spin")).toBeTruthy();
  const status = host.querySelector("[data-runtime-receipt-status]")!;
  expect(status.textContent).toContain(translate(locale, "runtime.receipt.busyRetry"));
  expectTransportDetailsHidden(host);
}

test("interrupt automatic retry announces busy feedback accessibly in English", async () => {
  const { host, root } = await renderInterruptAutoRetry("en");

  expectAccessibleBusyFeedback(host, "en");
  flushSync(() => root.unmount());
});

test("interrupt automatic retry announces busy feedback accessibly in Ukrainian", async () => {
  const { host, root } = await renderInterruptAutoRetry("uk");

  expectAccessibleBusyFeedback(host, "uk");
  flushSync(() => root.unmount());
});

test("transitive retry composition exposes one current leaf and keeps independent attempts", () => {
  type RetryReceipt = RuntimeReceipt & { retryOfOperationId?: string | null };
  const text = "preserve this production message";
  const original: RetryReceipt = {
    operationId: "op-original",
    idempotencyKey: "key-original",
    conversationId: "conv-one",
    kind: "send",
    status: "failed",
    reason: "dead-host",
    text,
    at: "2026-07-16T08:00:00.000Z",
    revision: 3,
  };
  const retry: RetryReceipt = {
    ...original,
    operationId: "op-retry",
    idempotencyKey: "key-retry",
    retryOfOperationId: original.operationId,
    at: "2026-07-16T08:00:01.000Z",
  };
  const leaf: RetryReceipt = {
    ...retry,
    operationId: "op-leaf",
    idempotencyKey: "key-leaf",
    retryOfOperationId: retry.operationId,
    at: "2026-07-16T08:00:02.000Z",
  };
  const projectedLeaf: RetryReceipt = {
    ...leaf,
    operationId: original.operationId,
    revision: 8,
  };
  const independent: RetryReceipt = {
    ...original,
    operationId: "op-independent",
    idempotencyKey: "key-independent",
    status: "queued",
    reason: null,
    at: "2026-07-16T08:00:03.000Z",
    revision: 1,
  };

  for (const [runtimeReceipts, immediateReceipts] of [
    [[original, retry, projectedLeaf, independent], [leaf]],
    [[leaf, independent], [original, retry, projectedLeaf]],
  ] as const) {
    const receipts = mergeRuntimeReceipts([...runtimeReceipts], [...immediateReceipts]);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(
      <RuntimeComposerReceipts receipts={receipts} onRetry={() => {}} onEdit={() => {}} />,
    ));

    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.idempotencyKey).sort()).toEqual(["key-independent", "key-leaf"]);
    // Identical text renders once; the queued current attempt owns the row and
    // the failed leaf survives as counted history without duplicate actions.
    expect(host.querySelectorAll("[data-receipt-message]")).toHaveLength(1);
    const attemptCount = host.querySelector("[data-receipt-attempt-count]")!;
    expect(attemptCount.textContent).toContain("×2");
    expect(host.querySelector("[data-receipt-history]")?.textContent)
      .toContain(translate("en", "receipt.human.deadHost"));
    expect(host.querySelectorAll("button")).toHaveLength(0);
    flushSync(() => root.unmount());
    host.remove();
  }
});

test("repeated identical attempts share one grouped row with counts and final state", () => {
  setLocale("uk");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const text = "Викинути TDLib history implementation і tests - давай";

  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[
        {
          operationId: "op-final",
          idempotencyKey: "key-final",
          conversationId: "conv-one",
          kind: "send",
          status: "failed",
          reason: "dead-host",
          text,
          at: "2026-07-16T10:00:02.000Z",
          revision: 1,
        },
        ...[1, 0].map((second) => ({
          operationId: `op-no-claim-${second}`,
          idempotencyKey: `key-no-claim-${second}`,
          conversationId: "conv-one",
          kind: "send" as const,
          status: "rejected" as const,
          reason: "no-claim",
          text,
          at: `2026-07-16T10:00:0${second}.000Z`,
          revision: 1,
        })),
      ]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  ));

  const summary = host.querySelector("summary")!;
  expect(summary.textContent).toContain("Спроб доставки: 3");
  expect(summary.textContent).toContain("проблем: 3");

  // One logical send consumes one row: the text appears once with an attempt
  // count and the final state, never once per attempt.
  const details = host.querySelector("[data-runtime-receipt-details]")!;
  const messages = details.querySelectorAll("[data-receipt-message]");
  expect(messages).toHaveLength(1);
  expect(messages[0]?.textContent).toBe(text);
  const attemptCount = details.querySelector("[data-receipt-attempt-count]")!;
  expect(attemptCount.textContent).toContain("×3");
  expect(attemptCount.getAttribute("aria-label")).toBe(translate("uk", "runtime.receipt.attemptCount", { count: 3 }));
  expect(details.querySelector('[data-receipt-status="failed"]')?.textContent)
    .toBe(translate("uk", "receipt.human.deadHost"));
  const history = details.querySelector("[data-receipt-history]")!;
  expect(history.textContent).toBe(`${translate("uk", "receipt.human.verbatim", { reason: "no-claim" })} ×2`);

  // One action set for the group, owned by the final failed attempt.
  const actions = [...details.querySelectorAll("button")];
  expect(actions.map((button) => button.textContent)).toEqual([
    translate("uk", "runtime.receipt.retry"),
    translate("uk", "runtime.receipt.edit"),
  ]);

  const status = host.querySelector("[data-runtime-receipt-status]")!;
  expect(status.textContent).toContain(translate("uk", "receipt.human.deadHost"));
  expect(status.textContent).toContain(`${translate("uk", "receipt.human.verbatim", { reason: "no-claim" })} ×2`);
  flushSync(() => root.unmount());
});

test("multiple delivery attempts collapse into one bounded accessible receipt stack", () => {
  setLocale("uk");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const text = "Критичний user policy для structured delivery";

  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[
        {
          operationId: "op-current",
          idempotencyKey: "key-current",
          conversationId: "conv-one",
          kind: "send",
          status: "queued",
          text,
          at: "2026-07-15T16:00:02.000Z",
          revision: 1,
        },
        {
          operationId: "op-stale-one",
          idempotencyKey: "key-stale-one",
          conversationId: "conv-one",
          kind: "send",
          status: "rejected",
          reason: "stale-turn",
          text,
          at: "2026-07-15T16:00:01.000Z",
          revision: 1,
        },
        {
          operationId: "op-stale-two",
          idempotencyKey: "key-stale-two",
          conversationId: "conv-one",
          kind: "send",
          status: "rejected",
          reason: "stale-turn",
          text,
          at: "2026-07-15T16:00:00.000Z",
          revision: 1,
        },
      ]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  ));

  const stack = host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement;
  expect(stack).toBeTruthy();
  expect(stack.open).toBe(false);
  const summary = stack.querySelector("summary")!;
  expect(summary.textContent).toContain("Спроб доставки: 3");
  expect(summary.textContent).toContain("очікують: 1");
  expect(summary.textContent).toContain("проблем: 2");
  expect(summary.querySelector("[data-receipt-preview]")?.textContent).toBe(text);
  expect(summary.getAttribute("aria-label")).toBe("Показати деталі доставки. Спроб доставки: 3");
  const statusId = summary.getAttribute("aria-describedby");
  expect(statusId).toBeTruthy();
  const status = host.querySelector(`#${statusId}`);
  expect(stack.contains(status)).toBe(false);
  expect(status?.getAttribute("role")).toBe("status");
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(status?.textContent).toContain("1 повідомлення очікує");
  expect(status?.textContent).toContain("2 проблеми");

  const details = stack.querySelector("[data-runtime-receipt-details]") as HTMLElement;
  expect(details.className).toContain("max-h-");
  expect(details.className).toContain("overflow-y-auto");
  // Identical attempts share one grouped row: the queued current attempt owns
  // it (optimistic marker, no duplicate actions) and the stale-turn rejections
  // stay visible as counted history.
  expect(details.querySelectorAll("[data-operation]")).toHaveLength(1);
  expect(details.querySelectorAll("[data-receipt-message]")).toHaveLength(1);
  expect(details.querySelector("[data-receipt-attempt-count]")?.textContent).toContain("×3");
  expect(details.querySelector("[data-receipt-history]")?.textContent)
    .toBe(`${translate("uk", "receipt.human.verbatim", { reason: "stale-turn" })} ×2`);
  expect(details.querySelector('[data-optimistic-message="true"]')?.textContent).toContain(text);
  expect(details.querySelectorAll("button")).toHaveLength(0);

  flushSync(() => root.unmount());
});

test("the 390px receipt row reserves preview space beside localized state counts", () => {
  (dom as unknown as { innerWidth: number }).innerWidth = 390;

  for (const locale of ["en", "uk"] as const) {
    setLocale(locale);
    const host = document.createElement("div");
    host.style.width = "390px";
    document.body.append(host);
    const root = createRoot(host);
    const text = "A long structured delivery message keeps a readable preview";
    flushSync(() => root.render(
      <RuntimeComposerReceipts
        receipts={[
          {
            operationId: `${locale}-busy`,
            idempotencyKey: `${locale}-busy-key`,
            conversationId: "conv-one",
            kind: "send",
            status: "queued",
            reason: "delivery-auto-retry",
            text,
            at: "2026-07-16T10:00:02.000Z",
            revision: 2,
          },
          ...[1, 0].map((second) => ({
            operationId: `${locale}-problem-${second}`,
            idempotencyKey: `${locale}-problem-key-${second}`,
            conversationId: "conv-one",
            kind: "send" as const,
            status: "rejected" as const,
            reason: "stale-turn",
            text,
            at: `2026-07-16T10:00:0${second}.000Z`,
            revision: 1,
          })),
        ]}
        onRetry={() => {}}
        onEdit={() => {}}
      />,
    ));

    const summary = host.querySelector("summary")!;
    expect(summary.className.split(/\s+/)).toContain("min-h-11");
    expect(summary.className.split(/\s+/)).toContain("max-h-11");
    expect(summary.className.split(/\s+/)).toContain("px-1.5");
    const preview = summary.querySelector("[data-receipt-preview]")!;
    expect(preview.className.split(/\s+/)).toContain("min-w-[3rem]");
    const counts = summary.querySelector("[data-receipt-counts]")!;
    expect(counts.className.split(/\s+/)).toContain("shrink-0");
    const pending = counts.querySelector("[data-receipt-pending-count]")!;
    const problems = counts.querySelector("[data-receipt-problem-count]")!;
    expect(pending.getAttribute("aria-label")).toBe(
      `${translate(locale, "runtime.receipt.pendingCount", { count: 1 })} · ${translate(locale, "runtime.receipt.busyRetry")}`,
    );
    expect(problems.getAttribute("aria-label"))
      .toBe(translate(locale, "runtime.receipt.problemCount", { count: 2 }));
    expect(pending.querySelector("[data-receipt-count-value]")?.textContent).toBe("1");
    expect(problems.querySelector("[data-receipt-count-value]")?.textContent).toBe("2");

    /* Expanded rows keep the message readable beside (or above) the action
       chip: the row wraps and the text reserves width instead of collapsing
       into a one-character column at 390px. */
    const message = host.querySelector("[data-runtime-receipt-details] [data-receipt-message]") as HTMLElement;
    expect(message.className.split(/\s+/)).toContain("min-w-[8rem]");
    expect(message.parentElement!.className.split(/\s+/)).toContain("flex-wrap");

    flushSync(() => root.unmount());
    host.remove();
  }
});

test("collapsed receipt disclosure keeps live status exposed through keyboard and touch toggles", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const receipt = {
    operationId: "op-accessible",
    idempotencyKey: "key-accessible",
    conversationId: "conv-one",
    kind: "send" as const,
    status: "queued" as const,
    queuePosition: 2,
    text: "keep status available",
    at: "2026-07-16T10:00:00.000Z",
    revision: 1,
  };
  const render = (status: "queued" | "delivering" | "failed") => flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[{
        ...receipt,
        status,
        reason: status === "failed" ? "dead-host" : null,
        revision: status === "failed" ? 2 : 1,
      }]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  ));

  render("queued");
  const stack = host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement;
  const summary = stack.querySelector("summary") as HTMLElement;
  const status = host.querySelector("[data-runtime-receipt-status]") as HTMLElement;
  const details = stack.querySelector("[data-runtime-receipt-details]") as HTMLElement;
  expect(stack.contains(status)).toBe(false);
  expect(status.getAttribute("role")).toBe("status");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).toContain(translate("en", "runtime.receipt.queuedPos", { position: 2 }));
  expect(summary.getAttribute("aria-label")).toContain(translate("en", "runtime.receipt.showDetails"));
  expect(summary.getAttribute("aria-label")).toContain(translate("en", "runtime.receipt.summary", { count: 1 }));
  expect(summary.className).toContain("max-h-");
  expect(stack.className).not.toContain("overflow-y-auto");
  expect(details.closest("details:not([open])")).toBe(stack);

  summary.focus();
  summary.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  flushSync(() => summary.click());
  expect(stack.open).toBe(true);
  expect(details.closest("details[open]")).toBe(stack);
  expect(summary.getAttribute("aria-label")).toContain(translate("en", "runtime.receipt.hideDetails"));
  expect(document.activeElement).toBe(summary);

  summary.dispatchEvent(new dom.PointerEvent("pointerup", { pointerType: "touch", bubbles: true }) as unknown as Event);
  flushSync(() => summary.click());
  expect(stack.open).toBe(false);
  expect(details.closest("details:not([open])")).toBe(stack);
  expect(summary.getAttribute("aria-label")).toContain(translate("en", "runtime.receipt.showDetails"));
  expect(document.activeElement).toBe(summary);

  const queuedAnnouncement = status.textContent;
  render("delivering");
  expect(stack.contains(status)).toBe(false);
  expect(status.textContent).toContain(translate("en", "runtime.receipt.delivering"));
  expect(status.textContent).not.toBe(queuedAnnouncement);
  expect(details.closest("details:not([open])")).toBe(stack);

  render("failed");
  expect(stack.contains(status)).toBe(false);
  expect(status.textContent).toContain("0 pending messages");
  expect(status.textContent).toContain("1 issue");
  expect(details.closest("details:not([open])")).toBe(stack);
  flushSync(() => root.unmount());
});

test("the disclosure state agrees with the details element across an empty-to-populated remount", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const receipt = (operationId: string, status: "queued" | "delivered"): RuntimeReceipt => ({
    operationId,
    idempotencyKey: `key-${operationId}`,
    conversationId: "conv-one",
    kind: "send",
    status,
    text: "watch the disclosure",
    at: "2026-07-16T10:00:00.000Z",
    revision: 1,
  });
  const render = (receipts: RuntimeReceipt[]) => flushSync(() => root.render(
    <RuntimeComposerReceipts receipts={receipts} onRetry={() => {}} onEdit={() => {}} />,
  ));

  render([receipt("op-first", "queued")]);
  const summary = host.querySelector("summary") as HTMLElement;
  flushSync(() => summary.click());
  expect((host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement).open).toBe(true);
  expect(summary.getAttribute("aria-label")).toContain(translate("en", "runtime.receipt.hideDetails"));

  // Every message receipt resolves: the details element unmounts while the
  // component itself stays mounted with its disclosure state.
  render([receipt("op-first", "delivered")]);
  expect(host.querySelector("details[data-runtime-receipt-stack]")).toBeNull();

  // A new attempt repopulates the stack: the fresh details element and the
  // disclosure label must agree — the remembered open state is restored.
  render([receipt("op-second", "queued")]);
  const stack = host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement;
  const reopenedSummary = stack.querySelector("summary")!;
  expect(stack.open).toBe(true);
  expect(reopenedSummary.getAttribute("aria-label")).toContain(translate("en", "runtime.receipt.hideDetails"));
  flushSync(() => root.unmount());
});

test("receipt summary keeps the pending count beside busy retry feedback", () => {
  setLocale("en");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[
        {
          operationId: "op-busy",
          idempotencyKey: "key-busy",
          conversationId: "conv-one",
          kind: "send",
          status: "queued",
          reason: "delivery-auto-retry",
          text: "retry this",
          at: "2026-07-15T16:00:01.000Z",
          revision: 1,
        },
        /* A steer already inside the running turn is resolved (issue #264):
           its bubble is in the transcript, so it renders no pending chrome. */
        {
          operationId: "op-started",
          idempotencyKey: "key-started",
          conversationId: "conv-one",
          kind: "steer",
          status: "turn-started",
          text: "then this",
          at: "2026-07-15T16:00:00.000Z",
          revision: 1,
        },
      ]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  ));

  const summary = host.querySelector("summary")!;
  expect(summary.textContent).not.toContain("then this");
  const pendingBadge = summary.querySelector("[data-receipt-pending-count]")!;
  expect(pendingBadge.getAttribute("aria-label")).toBe(
    `${translate("en", "runtime.receipt.pendingCount", { count: 1 })} · ${translate("en", "runtime.receipt.busyRetry")}`,
  );
  const status = host.querySelector("[data-runtime-receipt-status]");
  expect(status?.textContent).toContain("1 pending");
  expect(status?.textContent).toContain(translate("en", "runtime.receipt.busyRetry"));
  const busy = host.querySelector("[data-runtime-receipt-busy]") as HTMLElement;
  expect(busy.className).toContain("max-w-");
  expect(busy.className).toContain("truncate");
  flushSync(() => root.unmount());
});

test("all active delivery states use a neutral pending summary in both locales", () => {
  /* `turn-started`/`steered` are resolved, not active (issue #264): the
     message is inside the running turn, so they render nothing. */
  const activeStatuses = ["pending", "delivering", "queued", "uncertain"] as const;

  for (const locale of ["en", "uk"] as const) {
    setLocale(locale);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(
      <RuntimeComposerReceipts
        receipts={activeStatuses.map((status, index) => ({
          operationId: `${locale}-${status}`,
          idempotencyKey: `${locale}-key-${status}`,
          conversationId: "conv-one",
          kind: "send" as const,
          status,
          text: `${status} message`,
          at: `2026-07-15T16:00:0${index}.000Z`,
          revision: 1,
        }))}
        onRetry={() => {}}
        onEdit={() => {}}
      />,
    ));

    const summary = host.querySelector("summary")!;
    expect(summary.textContent).toContain(locale === "en" ? "pending: 4" : "очікують: 4");
    expect(summary.textContent).not.toContain(locale === "en" ? "queued: 4" : "черга: 4");
    expect(summary.getAttribute("aria-label")).toContain(translate(locale, "runtime.receipt.showDetails"));
    flushSync(() => root.unmount());
  }
});

test("expanded active attempts retain localized lifecycle status and aggregate counts", () => {
  const active = [
    { status: "pending" as const },
    { status: "queued" as const, queuePosition: 3 },
    { status: "uncertain" as const },
    { status: "delivering" as const },
  ];

  for (const locale of ["en", "uk"] as const) {
    setLocale(locale);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(
      <RuntimeComposerReceipts
        receipts={[
          ...active.map((receipt, index) => ({
            ...receipt,
            operationId: `${locale}-${receipt.status}`,
            idempotencyKey: `${locale}-key-${receipt.status}`,
            conversationId: "conv-one",
            kind: "send" as const,
            text: `${receipt.status} message`,
            at: `2026-07-16T09:00:0${index}.000Z`,
            revision: 1,
          })),
          {
            operationId: `${locale}-failed`,
            idempotencyKey: `${locale}-key-failed`,
            conversationId: "conv-one",
            kind: "send",
            status: "failed",
            reason: "dead-host",
            text: "failed message",
            at: "2026-07-16T09:00:04.000Z",
            revision: 2,
          },
        ]}
        onRetry={() => {}}
        onEdit={() => {}}
      />,
    ));

    const summary = host.querySelector("summary")!;
    expect(summary.textContent).toContain(translate(locale, "runtime.receipt.pendingCount", { count: 4 }));
    expect(summary.textContent).toContain(translate(locale, "runtime.receipt.problemCount", { count: 1 }));
    const details = host.querySelector("[data-runtime-receipt-details]")!;
    expect(details.querySelector('[data-receipt-status="pending"]')?.textContent)
      .toBe(translate(locale, "runtime.receipt.pending"));
    expect(details.querySelector('[data-receipt-status="queued"]')?.textContent)
      .toBe(translate(locale, "runtime.receipt.queuedPos", { position: 3 }));
    expect(details.querySelector('[data-receipt-status="uncertain"]')?.textContent)
      .toBe(translate(locale, "runtime.receipt.uncertain"));
    expect(details.querySelector('[data-receipt-status="delivering"]')?.textContent)
      .toBe(translate(locale, "runtime.receipt.delivering"));
    expect(details.querySelector('[data-receipt-status="failed"]')?.textContent)
      .toBe(translate(locale, "receipt.human.deadHost"));
    flushSync(() => root.unmount());
    host.remove();
  }
});

test("expanded receipt rows expose long multiline message text", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const text = `first line\n${"long content ".repeat(30)}`;

  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[{
        operationId: "op-long-multiline",
        idempotencyKey: "key-long-multiline",
        conversationId: "conv-one",
        kind: "send",
        status: "failed",
        reason: "delivery failed",
        text,
        at: "2026-07-15T16:00:00.000Z",
        revision: 1,
      }]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  ));

  const message = host.querySelector("[data-runtime-receipt-details] [data-receipt-message]") as HTMLElement;
  expect(message.textContent).toBe(text);
  expect(message.className).toContain("whitespace-pre-wrap");
  expect(message.className).toContain("break-words");
  expect(message.className).not.toContain("truncate");
  flushSync(() => root.unmount());
});

test("editing a rejected receipt does not submit the composer form", async () => {
  let edits = 0;
  let submits = 0;
  const { host, root } = await renderInto(
    <form onSubmit={(event) => { event.preventDefault(); submits += 1; }}>
      <RuntimeComposerReceipts
        receipts={[{
          operationId: "op-rejected",
          idempotencyKey: "key-rejected",
          conversationId: "conv-one",
          kind: "send",
          status: "rejected",
          reason: "stale delivery key",
          text: "try this again",
          at: "2026-07-13T00:00:00.000Z",
          revision: 3,
        }]}
        onRetry={() => {}}
        onEdit={() => { edits += 1; }}
      />
    </form>,
  );

  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit"));
  expect(edit).toBeDefined();
  await settle(() => edit!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  expect(edits).toBe(1);
  expect(submits).toBe(0);
  expect(edit!.getAttribute("type")).toBe("button");
  await act(async () => root.unmount());
});

test("editing and resending a rejected receipt uses a fresh delivery key", async () => {
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    if (sentKeys.length === 1) {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          structured: true,
          error: "delivery key was rejected",
          receipt: {
            operationId: "op-rejected",
            idempotencyKey: body.clientMessageId,
            conversationId: "conv-one",
            kind: "send",
            status: "rejected",
            reason: "delivery key was rejected",
            text: "try this again",
            at: "2026-07-13T00:00:00.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        structured: true,
        receipt: {
          operationId: "op-queued",
          idempotencyKey: body.clientMessageId,
          conversationId: "conv-one",
          kind: "send",
          status: "queued",
          text: "try this again",
          at: "2026-07-13T00:00:01.000Z",
          revision: 1,
        },
      }),
    } as Response;
  }) as typeof fetch;

  const file = {
    path: "/codex.jsonl",
    root: "codex-sessions",
    name: "codex.jsonl",
    project: "viewer",
    title: "Codex",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-one",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-one", "try this again");
  const { host, root } = await renderInto(<TmuxComposer file={file} />);

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("try this again");
  await settle(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));

  expect(sentKeys).toHaveLength(1);
  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit"));
  expect(edit).toBeDefined();
  await settle(() => edit!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settle(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));

  expect(sentKeys).toHaveLength(2);
  expect(sentKeys[1]).not.toBe(sentKeys[0]);
  // #258: the resent message surfaces as an optimistic in-flight bubble, not a
  // "delivery queued" toast.
  expect(host.textContent).not.toContain("Queued for durable delivery");
  expect(host.querySelector('[data-optimistic-message="true"]')?.textContent).toContain("try this again");
  await act(async () => root.unmount());
});

/** An in-flight message whose backend reason is an auto-retry (issue #258): the
    bubble must show a visible busy note, never the raw transport reason. */
async function renderInterruptAutoRetry(locale: "en" | "uk") {
  setLocale(locale);
  return renderInto(
    <RuntimeComposerReceipts
      receipts={[{
        operationId: `op-interrupt-auto-retry-${locale}`,
        idempotencyKey: `key-interrupt-auto-retry-${locale}`,
        conversationId: "conv-one",
        kind: "send",
        status: "queued",
        reason: "interrupt-auto-retry",
        text: "keep going",
        at: "2026-07-13T00:00:00.000Z",
        revision: 3,
      }]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  );
}

function expectTransportDetailsHidden(host: HTMLElement) {
  for (const transportText of ["thread/read", "interrupt-auto-retry", "delivery-auto-retry"]) {
    expect(host.textContent).not.toContain(transportText);
  }
}

test("interrupt automatic retry shows visible busy feedback in English", async () => {
  const { host, root } = await renderInterruptAutoRetry("en");
  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain(translate("en", "runtime.receipt.busyRetry"));
  expect(status?.querySelector(".sr-only")).toBeNull();
  expectTransportDetailsHidden(host);
  await act(async () => root.unmount());
});

test("interrupt automatic retry shows visible busy feedback in Ukrainian", async () => {
  const { host, root } = await renderInterruptAutoRetry("uk");
  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain(translate("uk", "runtime.receipt.busyRetry"));
  expect(status?.querySelector(".sr-only")).toBeNull();
  expectTransportDetailsHidden(host);
  await act(async () => root.unmount());
});

test("a dead host leaves the mic and send inert and never POSTs (§5, finding 5)", async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string) => {
    posts.push(String(input));
    return { ok: true, json: async () => ({ targets: {} }) } as Response;
  }) as typeof fetch;
  const file = {
    path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "Codex",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
    proc: "running", pid: null, conversationId: "conv-dead", pendingQuestion: null, waitingInput: null,
  } as FileEntry;
  const { host, root } = await renderInto(<TmuxComposer file={file} deadHost />);

  const buttons = [...host.querySelectorAll("button")];
  const mic = buttons.find((b) => (b.getAttribute("aria-label") ?? "").includes("Dictate")) as HTMLButtonElement;
  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  // dictation is disabled — a spoken message could never be delivered
  expect(mic.disabled).toBe(true);
  // send stays present as a draft surface but is inert (aria-disabled), no POST
  expect(send?.getAttribute("aria-disabled")).toBe("true");
  await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(posts.some((u) => u === "/api/tmux")).toBe(false);
  await act(async () => root.unmount());
});

test("an unresolved host blocks the send POST with a localized reason (finding 1)", async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string) => {
    posts.push(String(input));
    if (String(input) === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": "%1" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
  const file = {
    path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "Codex",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
    proc: "running", pid: null, conversationId: "conv-unresolved", pendingQuestion: null, waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-unresolved", "hello");
  const { host, root } = await renderInto(<TmuxComposer file={file} sendBlockedReason="resolving the agent host…" />);

  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  expect(send?.getAttribute("aria-disabled")).toBe("true");
  await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  // never messaged the legacy tmux endpoint while the host was unresolved
  expect(posts.some((u) => u === "/api/tmux")).toBe(false);
  await act(async () => root.unmount());
});

/* ------------------------------ quick-ack gating (round-3 MEDIUM) ------------------------------ */

const quickAckLabel = translate("en", "composer.quickAckLabel");
/* A live Claude subagent relays into its root, so quick-ack applies. In
   pure-legacy test mode (runtime plane off) a running proc makes this the
   `live-subagent` surface — Send enabled, so the composer renders and the
   quick-ack gating below is driven purely by the dead/unresolved props. A
   proc-null child would resolve to `inert` (Send hidden → no composer at all,
   finding 2), which is covered by the wrapper suites. */
const relaySubagent = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "viewer", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1, activity: "live",
  proc: "running", pid: null, conversationId: "conv-child", pendingQuestion: null, waitingInput: null,
} as FileEntry;

const openSendMenu = async (host: HTMLElement) => {
  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement;
  await settle(() => send.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true }) as unknown as Event));
};
const quickAckItems = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="menuitem"]')].filter((n) => (n.textContent ?? "").includes(quickAckLabel));

test("a live composer offers an enabled quick-ack in the send menu", async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ targets: {} }) } as Response)) as unknown as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={relaySubagent} />);
  await openSendMenu(host);
  const items = quickAckItems(host);
  expect(items.length).toBe(1);
  expect((items[0] as HTMLButtonElement).disabled).toBe(false);
  await act(async () => root.unmount());
});

test("a dead-host composer exposes no quick-ack action (finding: dead composer)", async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ targets: {} }) } as Response)) as unknown as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={relaySubagent} deadHost />);
  await openSendMenu(host);
  // the menu never opens (no actions) and no quick-ack item exists anywhere
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(quickAckItems(host).length).toBe(0);
  await act(async () => root.unmount());
});

test("an unresolved-host composer exposes no quick-ack action (finding: unresolved composer)", async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ targets: {} }) } as Response)) as unknown as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={relaySubagent} sendBlockedReason="resolving the agent host…" />);
  await openSendMenu(host);
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(quickAckItems(host).length).toBe(0);
  await act(async () => root.unmount());
});

test("receipt editing stays disabled while a newer send is in flight", async () => {
  let tmuxRequests = 0;
  let resolveSecond!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    tmuxRequests += 1;
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    if (tmuxRequests === 1) {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          structured: true,
          error: "delivery key was rejected",
          receipt: {
            operationId: "op-rejected-race",
            idempotencyKey: body.clientMessageId,
            conversationId: "conv-race",
            kind: "send",
            status: "rejected",
            reason: "delivery key was rejected",
            text: "first attempt",
            at: "2026-07-13T00:00:00.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }
    return new Promise<Response>((resolve) => { resolveSecond = resolve; });
  }) as typeof fetch;

  const file = {
    path: "/codex-race.jsonl",
    root: "codex-sessions",
    name: "codex-race.jsonl",
    project: "viewer",
    title: "Codex race",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-race",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-race", "first attempt");
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  await settle(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle(() => appendComposerDraft("conv-race", "second attempt"));
  expect(textarea.value).toBe("first attempt\n\nsecond attempt");

  await settle(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(tmuxRequests).toBe(2);
  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) as HTMLButtonElement;
  expect(edit).toBeDefined();
  expect(edit.disabled).toBe(true);
  await settle(() => edit.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(textarea.value).toBe("first attempt\n\nsecond attempt");

  await settle(() => resolveSecond({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      structured: true,
      receipt: {
        operationId: "op-race-delivered",
        idempotencyKey: "key-race-delivered",
        conversationId: "conv-race",
        kind: "send",
        status: "queued",
        text: "first attempt\n\nsecond attempt",
        at: "2026-07-13T00:00:01.000Z",
        revision: 1,
      },
    }),
  } as Response));
  expect(textarea.value).toBe("");
  await act(async () => root.unmount());
});

test("an idempotent retry whose first attempt already landed clears the draft", async () => {
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    if (sentKeys.length === 1) {
      /* The server accepted and delivers, yet the response is lost: a hard
         failure without a receipt keeps the draft for the retry. */
      return { ok: false, status: 503, json: async () => ({ ok: false, error: "runtime host request timed out" }) } as Response;
    }
    /* The retry replays the same key; the conflict carries the original
       delivered receipt — the message reached the agent and the turn runs. */
    return {
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        structured: true,
        error: "idempotency key already delivered",
        receipt: {
          operationId: "op-replayed",
          idempotencyKey: body.clientMessageId,
          conversationId: "conv-replay",
          kind: "send",
          status: "delivered",
          text: "deploy the hotfix",
          at: "2026-07-17T00:00:01.000Z",
          revision: 2,
        },
      }),
    } as Response;
  }) as typeof fetch;

  const file = {
    path: "/codex-replay.jsonl",
    root: "codex-sessions",
    name: "codex-replay.jsonl",
    project: "viewer",
    title: "Codex replay",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-replay",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-replay", "deploy the hotfix");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={file} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(textarea.value).toBe("deploy the hotfix");

  flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  /* Idempotent retry: the same delivery key both times, and the accepted
     delivery clears the draft from storage and the input. */
  expect(sentKeys).toHaveLength(2);
  expect(sentKeys[1]).toBe(sentKeys[0]);
  expect(textarea.value).toBe("");
  expect(sessionStorage.getItem("llvDraft:conv-replay")).toBe(null);
  flushSync(() => root.unmount());
});

test("a stale delivered replay never wipes a draft rewritten for the next turn", async () => {
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    requests += 1;
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    if (requests === 1) {
      return { ok: false, status: 503, json: async () => ({ ok: false, error: "runtime host request timed out" }) } as Response;
    }
    return {
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        structured: true,
        error: "idempotency key already delivered",
        receipt: {
          operationId: "op-stale-replay",
          idempotencyKey: body.clientMessageId,
          conversationId: "conv-stale",
          kind: "send",
          status: "delivered",
          text: "old turn ask",
          at: "2026-07-17T00:00:01.000Z",
          revision: 2,
        },
      }),
    } as Response;
  }) as typeof fetch;

  const file = {
    path: "/codex-stale.jsonl",
    root: "codex-sessions",
    name: "codex-stale.jsonl",
    project: "viewer",
    title: "Codex stale",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-stale",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-stale", "old turn ask");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={file} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  /* The user gives up on the old ask and rewrites the draft for a new turn. */
  sessionStorage.setItem("llvDraft:conv-stale", "");
  flushSync(() => appendComposerDraft("conv-stale", "brand new ask"));
  expect(textarea.value).toBe("brand new ask");

  flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  /* The second submit sends the NEW text under a fresh key; the delivered
     replay of the OLD turn must not clear the new draft's storage beyond what
     the accepted delivery covers. The new ask stays intact. */
  expect(textarea.value).toBe("brand new ask");
  expect(sessionStorage.getItem("llvDraft:conv-stale")).toBe("brand new ask");
  flushSync(() => root.unmount());
});

/* ── Issue #272: timeout followed by durable queued admission ───────────── */

/** Production shape of operation ac0223c0-2bef-46dd-a26e-143b758f66dc: the
    first `/api/tmux` send times out with an `uncertain` receipt, the operator
    types more while the fate is unknown, and the idempotent retry comes back
    `queued`. Queue admission is durable, so exactly the submitted generation
    must leave the composer — the later typing survives, the receipt stack
    carries the payload, and no stale failure lingers. */
async function runTimeoutThenQueuedAdmission(locale: "en" | "uk", viewportWidth: number) {
  (dom as unknown as { innerWidth: number }).innerWidth = viewportWidth;
  setLocale(locale);
  const conversationId = `conv-timeout-${locale}-${viewportWidth}`;
  const prompt = "довгий виробничий запит — ship the composer reconciliation contract";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string; text: string };
    sentKeys.push(body.clientMessageId);
    if (sentKeys.length === 1) {
      /* The runtime host request timed out; the server can only attest an
         uncertain receipt — nothing durable yet, the draft must stay. */
      return {
        ok: false,
        status: 503,
        json: async () => ({
          ok: false,
          structured: true,
          error: "runtime host request timed out",
          receipt: {
            operationId: "ac0223c0-2bef-46dd-a26e-143b758f66dc",
            idempotencyKey: body.clientMessageId,
            conversationId,
            kind: "send",
            status: "uncertain",
            reason: "runtime host request timed out",
            text: prompt,
            at: "2026-07-18T00:00:00.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }
    /* The idempotent retry replays the key: the operation is durably queued. */
    return {
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        structured: true,
        error: "idempotency key already accepted",
        receipt: {
          operationId: "ac0223c0-2bef-46dd-a26e-143b758f66dc",
          idempotencyKey: body.clientMessageId,
          conversationId,
          kind: "send",
          status: "queued",
          text: prompt,
          at: "2026-07-18T00:00:02.000Z",
          revision: 2,
        },
      }),
    } as Response;
  }) as typeof fetch;

  const file = {
    path: `/codex-timeout-${locale}-${viewportWidth}.jsonl`,
    root: "codex-sessions",
    name: "codex-timeout.jsonl",
    project: "viewer",
    title: "Codex timeout",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  if (viewportWidth <= 430) host.style.width = `${viewportWidth}px`;
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={file} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const submit = async () => {
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    await submit();
    /* The timeout is a truthful failure: the draft stays editable and the
       error is announced. */
    expect(textarea.value).toBe(prompt);
    expect(host.textContent).toContain("runtime host request timed out");

    /* The operator keeps typing while the first attempt's fate is unknown. */
    flushSync(() => appendComposerDraft(conversationId, "додатково: also add tests"));
    expect(textarea.value).toBe(`${prompt}\n\nдодатково: also add tests`);

    await submit();
    /* Same delivery key both times — an uncertain receipt never rotates it,
       so the retry replays instead of double-sending. */
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    /* Durable queue admission clears exactly the submitted generation: the
       typing that followed survives, in the editor and in storage. */
    expect(textarea.value).toBe("додатково: also add tests");
    expect(sessionStorage.getItem(`llvDraft:${conversationId}`)).toBe("додатково: also add tests");
    /* No stale failure lingers after admission. */
    expect(host.textContent).not.toContain("runtime host request timed out");
    expect(host.textContent).not.toContain(translate(locale, "common.failedSend"));
    /* The payload lives on in a compact truthful receipt: queued, pending
       count of one, preview text — announced through the live status region. */
    const stack = host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement;
    expect(stack).toBeTruthy();
    const summary = stack.querySelector("summary")!;
    expect(summary.textContent).toContain(translate(locale, "runtime.receipt.summary", { count: 1 }));
    expect(summary.querySelector("[data-receipt-preview]")?.textContent).toBe(prompt);
    expect(summary.querySelector("[data-receipt-pending-count] [data-receipt-count-value]")?.textContent).toBe("1");
    expect(host.querySelector('[data-receipt-status="queued"]')?.textContent)
      .toBe(translate(locale, "runtime.receipt.queued"));
    expect(host.querySelector('[data-optimistic-message="true"]')?.textContent).toContain(prompt);
    const status = host.querySelector("[data-runtime-receipt-status]")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain(translate(locale, "runtime.receipt.statusPending", { count: 1 }));
    /* Mobile keeps the 44px summary row; desktop keeps the compact stack. */
    expect(summary.className.split(/\s+/)).toContain("min-h-11");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    (dom as unknown as { innerWidth: number }).innerWidth = 1024;
  }
}

test("a timed-out send settles on queued admission via idempotent retry (desktop, EN)", async () => {
  await runTimeoutThenQueuedAdmission("en", 1024);
});

test("a timed-out send settles on queued admission via idempotent retry (390px, UK)", async () => {
  await runTimeoutThenQueuedAdmission("uk", 390);
});
