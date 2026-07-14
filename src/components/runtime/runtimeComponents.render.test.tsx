import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";

import { ConnectionPillView } from "@/components/ConnectionPill";
import { AttentionCard } from "./AttentionCard";
import { ReceiptChip } from "./ReceiptChip";
import type { RuntimeAttention, RuntimeReceipt } from "./runtimeModel";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

/* --------------------------- ConnectionPill --------------------------- */

test("connection pill renders every state with a text label and a polite status region", () => {
  for (const connection of ["live", "reconnecting", "degraded", "offline"] as const) {
    const html = renderToStaticMarkup(
      <ConnectionPillView connection={connection} resynced={false} announce={`announce-${connection}`} t={t} />,
    );
    expect(html).toContain(`data-connection="${connection}"`);
    expect(html).toContain(translate("en", `runtime.${connection}`));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(`announce-${connection}`);
  }
});

test("connection pill shows the transient resynced note and legacy provenance", () => {
  const html = renderToStaticMarkup(
    <ConnectionPillView connection="live" resynced legacy announce="x" t={t} />,
  );
  expect(html).toContain(translate("en", "runtime.resynced"));
  expect(html).toContain(translate("en", "runtime.legacyProvenance"));
});

test("live pill pulses but honors reduced motion", () => {
  const html = renderToStaticMarkup(<ConnectionPillView connection="live" resynced={false} announce="x" t={t} />);
  expect(html).toContain("animate-pulse");
  expect(html).toContain("motion-reduce:animate-none");
});

/* ------------------------------ ReceiptChip ------------------------------ */

function receipt(overrides: Partial<RuntimeReceipt>): RuntimeReceipt {
  return {
    operationId: "op_1",
    idempotencyKey: "op_1",
    conversationId: "conv_a",
    kind: "send",
    status: "queued",
    at: "2026-07-10T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

test("receipt chip renders status as text, not color alone", () => {
  const html = renderToStaticMarkup(<ReceiptChip receipt={receipt({ status: "steered" })} />);
  expect(html).toContain(translate("en", "runtime.receipt.steered"));
  expect(html).toContain('data-receipt-status="steered"');
});

test("queued receipt shows its position", () => {
  const html = renderToStaticMarkup(<ReceiptChip receipt={receipt({ status: "queued", queuePosition: 3 })} />);
  expect(html).toContain(translate("en", "runtime.receipt.queuedPos", { position: 3 }));
});

test("queued automatic delivery hides its transport reason", () => {
  const html = renderToStaticMarkup(
    <ReceiptChip receipt={receipt({ status: "queued", reason: "delivery-auto-retry" })} />,
  );
  expect(html).toContain(translate("en", "runtime.receipt.queued"));
  expect(html).not.toContain("delivery-auto-retry");
});

test("delivering receipt is localized in English and Ukrainian", () => {
  const html = renderToStaticMarkup(<ReceiptChip receipt={receipt({ status: "delivering" })} />);
  expect(html).toContain(translate("en", "runtime.receipt.delivering"));
  expect(translate("uk", "runtime.receipt.delivering")).toBe("доставляється…");
});

test("failed receipt is announced politely, shows the reason verbatim, and offers retry/edit", () => {
  const html = renderToStaticMarkup(
    <ReceiptChip receipt={receipt({ status: "failed", reason: "dead-host" })} onRetry={() => {}} onEdit={() => {}} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("dead-host");
  expect(html).toContain(translate("en", "runtime.receipt.retry"));
  expect(html).toContain("resend"); // "Edit & resend" — the & is HTML-escaped in static markup
  expect(html.match(/min-h-11/g)?.length).toBe(2);
});

/* ------------------------------ AttentionCard ------------------------------ */

function attention(overrides: Partial<RuntimeAttention>): RuntimeAttention {
  return {
    id: "att_1",
    conversationId: "conv_a",
    kind: "approval",
    state: "open",
    unowned: false,
    createdAt: "2026-07-10T00:00:00.000Z",
    request: { command: "rm -rf build" },
    ...overrides,
  };
}

test("approval attention renders the structured command and keyboard-operable approve/deny", () => {
  const html = renderToStaticMarkup(<AttentionCard attention={attention({})} onApprove={() => {}} onDeny={() => {}} />);
  expect(html).toContain("rm -rf build");
  expect(html).toContain(translate("en", "runtime.attention.approve"));
  expect(html).toContain(translate("en", "runtime.attention.deny"));
  expect(html).toContain(translate("en", "runtime.attention.keysHint"));
  expect(html).toContain('data-attention-kind="approval"');
});

test("unowned attention raises a top-of-queue alarm", () => {
  const html = renderToStaticMarkup(<AttentionCard attention={attention({ unowned: true })} onApprove={() => {}} onDeny={() => {}} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain(translate("en", "runtime.attention.unowned"));
});

test("heuristic attention is visually distinct and labelled low-confidence", () => {
  const html = renderToStaticMarkup(<AttentionCard attention={attention({ kind: "waiting_heuristic", request: { detail: "A or B?" } })} />);
  expect(html).toContain('data-attention-kind="waiting_heuristic"');
  expect(html).toContain(translate("en", "runtime.attention.heuristicNote"));
  expect(html).toContain("border-dashed");
});

test("question attention renders its options", () => {
  const html = renderToStaticMarkup(
    <AttentionCard
      attention={attention({ kind: "question", request: { question: { prompt: "Pick one", options: [{ label: "Alpha" }, { label: "Beta", recommended: true }] } } })}
      onAnswerQuestion={() => {}}
    />,
  );
  expect(html).toContain("Pick one");
  expect(html).toContain("Alpha");
  expect(html).toContain("Beta");
});

test("auto-resolution shows a display-only countdown", () => {
  const html = renderToStaticMarkup(<AttentionCard attention={attention({ kind: "permission", request: { tool: "Bash" }, autoResolutionMs: 30_000 })} onApprove={() => {}} onDeny={() => {}} />);
  expect(html).toContain(translate("en", "runtime.attention.expiresIn", { seconds: 30 }));
  expect(html).toContain('role="timer"');
});
