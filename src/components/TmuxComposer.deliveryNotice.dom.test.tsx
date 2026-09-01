/**
 * Issue #1362 — failed deliveries under the composer are one compact notice.
 *
 * The operator photographed three identical full-width red pills, each
 * carrying the whole error sentence with its tail clipped, one per retry. These
 * tests pin the replacement: identical consecutive failures fold into ONE
 * notice with an attempt counter, the at-rest form is a glyph plus a terse
 * cause, the full sentence and its remediation live behind expand/hover, and
 * dismissing the notice clears the group.
 *
 * Self-contained: the receipt stack is rendered directly, so nothing here mocks
 * a module, touches the runtime bus, or reads any state directory.
 */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate, type Locale } from "@/lib/i18n";

import type { RuntimeReceipt } from "./runtime/runtimeModel";

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

const HOST_DOWN = "structured spawn runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
const HOST_DOWN_SENTENCE = "structured spawn runtime host is unavailable";
const HOST_DOWN_REMEDIATION = "start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
const MESSAGE = "please rerun the failing suite and report";

function receipt(overrides: Partial<RuntimeReceipt> & { operationId: string }): RuntimeReceipt {
  return {
    idempotencyKey: `key-${overrides.operationId}`,
    conversationId: "conversation_1362",
    kind: "send",
    status: "failed",
    reason: HOST_DOWN,
    text: MESSAGE,
    at: "2026-08-31T10:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

/** Three failed retries of one message: same text, distinct attempts. */
const threeRetries = (): RuntimeReceipt[] => [2, 1, 0].map((second) =>
  receipt({ operationId: `op-retry-${second}`, at: `2026-08-31T10:00:0${second}.000Z` }));

interface Mounted {
  host: HTMLElement;
  root: Root;
  stack: () => HTMLDetailsElement;
  summary: () => HTMLElement;
  cleanup: () => void;
}

type Props = Partial<React.ComponentProps<typeof RuntimeComposerReceipts>> & { receipts: RuntimeReceipt[] };

function view(props: Props): React.ReactElement {
  const stamps = props.receipts.map((entry) => Date.parse(entry.at)).filter(Number.isFinite);
  return (
    <RuntimeComposerReceipts
      onRetry={() => {}}
      onEdit={() => {}}
      nowMs={(stamps.length ? Math.max(...stamps) : 0) + 1_000}
      session={{ host: "hosted", turn: "idle" }}
      {...props}
    />
  );
}

function mount(props: Props, width = 1280): Mounted {
  (dom as unknown as { innerWidth: number }).innerWidth = width;
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(view(props)); });
  return {
    host,
    root,
    stack: () => host.querySelector("details[data-runtime-receipt-stack]") as HTMLDetailsElement,
    summary: () => host.querySelector("details[data-runtime-receipt-stack] > summary") as HTMLElement,
    cleanup: () => {
      act(() => { root.unmount(); });
      host.remove();
    },
  };
}

const rerender = (mounted: Mounted, props: Props) => act(() => { mounted.root.render(view(props)); });
const click = (element: Element) => act(() => { (element as HTMLElement).click(); });
/** Clicks one of the notice's own buttons and reports whether the handler
    marked the click handled. In a browser the button's activation already
    outranks the summary's, so the disclosure never toggles; the explicit
    preventDefault is what a DOM that toggles on bubble (happy-dom) would need,
    and it is the part the component controls. */
const clickAction = (button: Element): boolean => {
  const event = new dom.MouseEvent("click", { bubbles: true, cancelable: true });
  act(() => { button.dispatchEvent(event as unknown as Event); });
  return (event as unknown as Event).defaultPrevented;
};
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

afterEach(() => {
  setLocale("en");
  (dom as unknown as { innerWidth: number }).innerWidth = 1280;
});

for (const locale of ["en", "uk"] as const satisfies readonly Locale[]) {
  test(`#1362 three failed retries of one message collapse into one compact notice with ×3 (${locale})`, () => {
    setLocale(locale);
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
    const mounted = mount({ receipts: threeRetries(), onDismiss: () => {} });
    const stack = mounted.stack();
    const summary = mounted.summary();

    /* One notice, collapsed, standing in for the accordion's summary line. */
    expect(mounted.host.querySelectorAll("details[data-delivery-notice]")).toHaveLength(1);
    expect(stack.hasAttribute("data-delivery-notice")).toBe(true);
    expect(stack.open).toBe(false);

    /* At rest: glyph + "not delivered — <terse cause>" + counter. */
    const line = `${t("composer.receiptFailed")} — ${t("receipt.cause.hostUnavailable")}`;
    const cause = summary.querySelector("[data-delivery-notice-cause]") as HTMLElement;
    expect(cause.textContent).toBe(line);
    expect(summary.querySelector("svg")).not.toBeNull();
    const counter = summary.querySelector("[data-delivery-notice-count]") as HTMLElement;
    expect(counter.textContent).toContain("×3");
    expect(counter.textContent).toContain(t("runtime.receipt.attemptCount", { count: 3 }));
    expect(summary.getAttribute("aria-label"))
      .toBe(`${t("runtime.receipt.showDetails")}. ${line}. ${t("runtime.receipt.attemptCount", { count: 3 })}`);

    /* Never the full sentence in the row, and never a pill per attempt. */
    expect(summary.textContent).not.toContain(HOST_DOWN_SENTENCE);
    expect(summary.textContent).not.toContain(HOST_DOWN_REMEDIATION);
    expect(summary.querySelector("[data-receipt-preview]")).toBeNull();
    expect(summary.querySelector("[data-receipt-problem-count]")).toBeNull();
    expect(summary.querySelector("[data-receipt-status]")).toBeNull();
    expect(summary.querySelector(".bg-danger-soft")).toBeNull();
    /* Hover carries the whole sentence. */
    expect(cause.getAttribute("title")).toBe(HOST_DOWN);

    /* The detailed history keeps one row for the one message, counted. */
    const details = stack.querySelector("[data-runtime-receipt-details]") as HTMLElement;
    expect(details.querySelectorAll("[data-receipt-message]")).toHaveLength(1);
    expect(details.querySelector("[data-receipt-attempt-count]")?.textContent).toContain("×3");
    expect(details.querySelectorAll("[data-receipt-status]")).toHaveLength(1);

    /* The live region still counts every failed attempt. */
    const status = mounted.host.querySelector("[data-runtime-receipt-status]") as HTMLElement;
    expect(status.textContent).toContain(t("runtime.receipt.statusProblems", { count: 3 }));
    mounted.cleanup();
  });
}

test("#1362 expanding the notice reveals the full cause and its remediation, once", () => {
  const mounted = mount({ receipts: threeRetries(), onDismiss: () => {} });
  const stack = mounted.stack();
  const summary = mounted.summary();
  const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

  click(summary);
  expect(stack.open).toBe(true);
  expect(summary.getAttribute("aria-label")).toContain(t("runtime.receipt.hideDetails"));

  const details = stack.querySelector("[data-runtime-receipt-details]") as HTMLElement;
  const detail = details.querySelector("[data-delivery-notice-detail]") as HTMLElement;
  expect(detail).not.toBeNull();
  expect(detail.querySelector("[data-delivery-notice-sentence]")?.textContent).toBe(HOST_DOWN_SENTENCE);
  expect(detail.querySelector("[data-delivery-notice-remediation]")?.textContent).toBe(HOST_DOWN_REMEDIATION);
  /* The sentence is explained once for the run, never once per attempt. */
  expect(mounted.host.querySelectorAll("[data-delivery-notice-sentence]")).toHaveLength(1);
  /* The history row's chip says the terse cause, never the whole sentence
     again — that rides on its hover, and the detail block above already
     showed it. */
  const chip = details.querySelector('[data-receipt-status="failed"]') as HTMLElement;
  expect(chip.textContent).toBe(translate("en", "receipt.human.verbatim", { reason: t("receipt.cause.hostUnavailable") }));
  expect(chip.getAttribute("title")).toBe(translate("en", "receipt.human.verbatim", { reason: HOST_DOWN }));
  expect(details.querySelector("[data-receipt-history]")?.textContent)
    .toBe(`${translate("en", "receipt.human.verbatim", { reason: t("receipt.cause.hostUnavailable") })} ×2`);
  /* The row's own action set is still there, behind the notice. */
  const labels = [...details.querySelectorAll("button")].map((button) => button.textContent || button.getAttribute("aria-label"));
  expect(labels).toContain(t("runtime.receipt.retry"));
  expect(labels).toContain(t("runtime.receipt.edit"));
  expect(labels).toContain(t("runtime.receipt.dismiss"));

  click(summary);
  expect(stack.open).toBe(false);
  mounted.cleanup();
});

test("#1362 dismissing the collapsed notice clears the whole group and leaves a pending delivery alone", () => {
  const batches: string[][] = [];
  const pending = receipt({
    operationId: "op-pending",
    status: "queued",
    reason: null,
    text: "a different, still-moving ask",
    at: "2026-08-31T10:00:05.000Z",
  });
  const mounted = mount({ receipts: [pending, ...threeRetries()], onDismiss: (ids) => batches.push(ids) });
  const summary = mounted.summary();
  expect(mounted.stack().hasAttribute("data-delivery-notice")).toBe(true);
  expect(summary.querySelector("[data-receipt-pending-count]")).not.toBeNull();

  const dismiss = summary.querySelector("[data-delivery-notice-dismiss]") as HTMLButtonElement;
  expect(dismiss.getAttribute("aria-label")).toBe(translate("en", "runtime.receipt.dismiss"));
  /* Dismissing is not expanding: the click is handled by the button alone. */
  expect(clickAction(dismiss)).toBe(true);
  expect(batches).toEqual([["op-retry-2", "op-retry-1", "op-retry-0"]]);

  rerender(mounted, { receipts: [pending, ...threeRetries()], dismissed: new Set(batches.flat()), onDismiss: () => {} });
  expect(mounted.host.querySelector("details[data-delivery-notice]")).toBeNull();
  expect(mounted.summary().querySelector("[data-receipt-pending-count]")).not.toBeNull();
  expect(mounted.summary().textContent).toContain(translate("en", "runtime.receipt.summary", { count: 1 }));

  rerender(mounted, { receipts: threeRetries(), dismissed: new Set(batches.flat()), onDismiss: () => {} });
  expect(mounted.host.textContent).toBe("");
  mounted.cleanup();
});

test("#1362 the notice retries the newest failed attempt, and offers no retry for a rejection or a discard", () => {
  const retries: string[] = [];
  const mounted = mount({
    receipts: threeRetries(),
    onDismiss: () => {},
    onRetry: (target, mode) => retries.push(`${target.operationId}:${mode ?? "same-key"}`),
  });
  const retry = mounted.summary().querySelector("[data-delivery-notice-retry]") as HTMLButtonElement;
  expect(retry.getAttribute("aria-label")).toBe(translate("en", "runtime.receipt.retry"));
  expect(clickAction(retry)).toBe(true);
  expect(retries).toEqual(["op-retry-2:same-key"]);

  rerender(mounted, {
    receipts: [receipt({ operationId: "op-verify", resend: "verify-first", reason: "delivery outcome is unverified" })],
    onDismiss: () => {},
    onRetry: (target, mode) => retries.push(`${target.operationId}:${mode ?? "same-key"}`),
  });
  clickAction(mounted.summary().querySelector("[data-delivery-notice-retry]") as HTMLButtonElement);
  expect(retries).toEqual(["op-retry-2:same-key", "op-verify:uncertain"]);

  rerender(mounted, { receipts: [receipt({ operationId: "op-rejected", status: "rejected", reason: "stale-turn" })], onDismiss: () => {} });
  expect(mounted.summary().querySelector("[data-delivery-notice-retry]")).toBeNull();
  expect(mounted.summary().querySelector("[data-delivery-notice-dismiss]")).not.toBeNull();

  rerender(mounted, { receipts: [receipt({ operationId: "op-discarded", reason: "delivery-discarded" })], onDismiss: () => {} });
  expect(mounted.summary().querySelector("[data-delivery-notice-retry]")).toBeNull();
  mounted.cleanup();
});

test("#1362 a known reason code reads as its human sentence with nothing further to reveal", () => {
  const mounted = mount({ receipts: [receipt({ operationId: "op-dead", reason: "dead-host" })], onDismiss: () => {} });
  const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
  const cause = mounted.summary().querySelector("[data-delivery-notice-cause]") as HTMLElement;
  expect(cause.textContent).toBe(`${t("composer.receiptFailed")} — ${t("receipt.human.deadHost")}`);
  expect(mounted.summary().querySelector("[data-delivery-notice-count]")).toBeNull();
  click(mounted.summary());
  expect(mounted.stack().open).toBe(true);
  expect(mounted.host.querySelector("[data-delivery-notice-detail]")).toBeNull();
  mounted.cleanup();
});

test("#1362 identical consecutive failures collapse; an older different cause stays in the history", () => {
  const batches: string[][] = [];
  const receipts = [
    receipt({ operationId: "op-host-2", text: "second ask", at: "2026-08-31T10:00:02.000Z" }),
    receipt({ operationId: "op-host-1", text: "first ask", at: "2026-08-31T10:00:01.000Z" }),
    receipt({ operationId: "op-dead", text: "older ask", reason: "dead-host", at: "2026-08-31T10:00:00.000Z" }),
  ];
  const mounted = mount({ receipts, onDismiss: (ids) => batches.push(ids) });
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);
  const summary = mounted.summary();
  expect(summary.querySelector("[data-delivery-notice-cause]")?.textContent)
    .toBe(`${t("composer.receiptFailed")} — ${t("receipt.cause.hostUnavailable")}`);
  expect(summary.querySelector("[data-delivery-notice-count]")?.textContent).toContain("×2");
  const details = mounted.stack().querySelector("[data-runtime-receipt-details]") as HTMLElement;
  expect(details.querySelectorAll("[data-receipt-message]")).toHaveLength(3);
  expect(mounted.host.querySelector("[data-runtime-receipt-status]")?.textContent)
    .toContain(t("runtime.receipt.statusProblems", { count: 3 }));

  clickAction(summary.querySelector("[data-delivery-notice-dismiss]") as HTMLButtonElement);
  expect(batches).toEqual([["op-host-2", "op-host-1"]]);

  /* With the run dismissed the older cause surfaces as the next notice. */
  rerender(mounted, { receipts, dismissed: new Set(batches.flat()), onDismiss: () => {} });
  expect(mounted.summary().querySelector("[data-delivery-notice-cause]")?.textContent)
    .toBe(`${t("composer.receiptFailed")} — ${t("receipt.human.deadHost")}`);
  expect(mounted.summary().querySelector("[data-delivery-notice-count]")).toBeNull();
  mounted.cleanup();
});

test("#1362 textless failed sends collapse into the notice instead of stacking as standalone pills", () => {
  const batches: string[][] = [];
  const receipts = [2, 1, 0].map((second) =>
    receipt({ operationId: `op-textless-${second}`, text: null, at: `2026-08-31T10:00:0${second}.000Z` }));
  const mounted = mount({ receipts, onDismiss: (ids) => batches.push(ids) });
  const stack = mounted.stack();
  expect(stack.hasAttribute("data-delivery-notice")).toBe(true);
  expect(mounted.summary().querySelector("[data-delivery-notice-count]")?.textContent).toContain("×3");
  /* Every chip lives inside the accordion's history now; nothing stacks beside it. */
  const chips = [...mounted.host.querySelectorAll("[data-receipt-status]")];
  expect(chips).toHaveLength(1);
  expect(chips.every((chip) => stack.contains(chip))).toBe(true);
  const row = stack.querySelector("[data-receipt-standalone-row]") as HTMLElement;
  expect(row.querySelector("[data-receipt-attempt-count]")?.textContent).toContain("×3");
  expect(mounted.host.querySelectorAll("[data-receipt-message]")).toHaveLength(0);

  clickAction(mounted.summary().querySelector("[data-delivery-notice-dismiss]") as HTMLButtonElement);
  expect(batches).toEqual([["op-textless-2", "op-textless-1", "op-textless-0"]]);
  rerender(mounted, { receipts, dismissed: new Set(batches.flat()), onDismiss: () => {} });
  expect(mounted.host.textContent).toBe("");
  mounted.cleanup();
});

test("#1362 the notice holds its anatomy at desktop and 390px in both locales", () => {
  /* No pixel browser in CI — acceptance is structural: the classes that carry
     the layout contract (one line, truncating cause, touch-sized actions, the
     danger edge without a red wash) must be present at both widths. */
  for (const width of [1280, 390] as const) {
    for (const locale of ["en", "uk"] as const) {
      setLocale(locale);
      const mounted = mount({ receipts: threeRetries(), onDismiss: () => {} }, width);
      const stack = mounted.stack();
      const summary = mounted.summary();

      const container = classes(stack);
      expect(container).toContain("border-l-danger");
      expect(container).not.toContain("bg-danger-soft");
      expect(container).toContain("text-caption");

      const row = classes(summary);
      expect(row).toContain("min-h-11");
      expect(row).toContain("max-h-11");
      expect(row).toContain("overflow-hidden");
      expect(row).not.toContain("py-1");

      const cause = classes(summary.querySelector("[data-delivery-notice-cause]")!);
      expect(cause).toContain("min-w-0");
      expect(cause).toContain("flex-1");
      expect(cause).toContain("truncate");
      expect(classes(summary.querySelector("[data-delivery-notice-count]")!)).toContain("shrink-0");

      /* 44px touch targets: a 44px-tall box whose hit area extends 6px past
         each side of its 32px width (the composer's icon-button pattern), so
         two of them leave the cause its width at 390px. */
      for (const selector of ["[data-delivery-notice-retry]", "[data-delivery-notice-dismiss]"]) {
        const button = classes(summary.querySelector(selector)!);
        expect(button).toContain("h-11");
        expect(button).toContain("w-8");
        expect(button).toContain("before:-inset-x-1.5");
        expect(button).not.toContain("rounded-full");
      }

      click(summary);
      const sentence = classes(stack.querySelector("[data-delivery-notice-sentence]")!);
      expect(sentence).toContain("break-words");
      mounted.cleanup();
    }
  }
});
