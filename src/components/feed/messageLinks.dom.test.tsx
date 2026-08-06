import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate, type TFunction } from "@/lib/i18n";
import type { ReviewCardItem } from "@/lib/review";
import { OutboxBubblesView } from "@/components/conversation/OutboxBubbles";
import type { OutboxEntry } from "@/components/conversation/outbox";
import { StreamingMd } from "./markdown";
import { FeedItem } from "./FeedItem";
import type { Item } from "./parse";
import { ReviewCard } from "./cards/ReviewCard";

/**
 * Every message surface renders the full link set (operator report, 2026-08-06).
 *
 * The reported message was an agent's release note whose bullets read
 * `- **[#2722](https://…/pull/2722)** — …`: the link sits INSIDE bold, and the
 * inline pass used to hand the whole bold run to <b> as raw text, so the
 * brackets and parens showed verbatim while the bold itself rendered. Each
 * surface below renders the same sample and must produce the same anchors.
 */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
setLocale("en");

const SAMPLE = [
  "Shipped **today**:",
  "",
  "- **[#2722](https://example.com/acme/widgets/pull/2722)** — merged",
  "- [#2723](https://example.com/acme/widgets/pull/2723) — open",
  "",
  "> **[#2724](https://example.com/acme/widgets/pull/2724)** quoted",
  "",
  "Bare https://example.com/acme/widgets/issues/7 too.",
].join("\n");

/** Every href the sample must produce, in source order. */
const HREFS = [
  "https://example.com/acme/widgets/pull/2722",
  "https://example.com/acme/widgets/pull/2723",
  "https://example.com/acme/widgets/pull/2724",
  "https://example.com/acme/widgets/issues/7",
];

let root: Root | null = null;

beforeEach(() => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  dom.document.body.replaceChildren();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root!.render(node);
  });
}

/** The links the surface actually rendered — and nothing left literal. */
function renderedLinks(): string[] {
  const text = dom.document.body.textContent ?? "";
  expect(text).not.toContain("](https://");
  expect(text).not.toContain("**");
  return [...dom.document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

function item(partial: Record<string, unknown>): Item {
  return partial as unknown as Item;
}

const translator = (locale: "en"): TFunction => (key, params) => translate(locale, key, params);

test("a transcript prose message links every reference", async () => {
  await render(<FeedItem item={item({ kind: "prose", ts: 0, text: SAMPLE, engine: "claude" })} />);
  expect(renderedLinks()).toEqual(HREFS);
});

test("a user bubble links every reference", async () => {
  await render(<FeedItem item={item({ kind: "user", ts: 0, text: SAMPLE })} />);
  expect(renderedLinks()).toEqual(HREFS);
});

/* A long teammate message keeps a raw truncated excerpt behind its expander, so
   this case uses a short body — the card's own markdown render. */
test("a teammate message card links every reference", async () => {
  const short = "Shipped: **[#2722](https://example.com/acme/widgets/pull/2722)** — merged";
  await render(<FeedItem item={item({ kind: "tmsg", ts: 0, dir: "in", peer: "worker", summary: `**[#2723](${HREFS[1]})** landed`, text: short })} />);
  expect(renderedLinks()).toEqual([HREFS[1], HREFS[0]]);
});

test("a review card links every reference in its findings", async () => {
  const review: ReviewCardItem = {
    kind: "review",
    ts: 0,
    verdict: "COMMENT",
    summary: [SAMPLE],
    findings: [{ severity: "Low", title: "**[#2722](https://example.com/acme/widgets/pull/2722)** — merged", body: "" }],
    raw: "",
  };
  await render(<ReviewCard item={review} />);
  expect(renderedLinks()).toEqual([...HREFS, HREFS[0]]);
});

test("a live streaming row links every reference once its lines settle", async () => {
  for (let end = 12; end < SAMPLE.length; end += 12) {
    await render(<StreamingMd text={SAMPLE.slice(0, end)} streaming />);
  }
  await render(<StreamingMd text={SAMPLE} streaming={false} />);
  expect(renderedLinks()).toEqual(HREFS);
});

test("a queued outbox bubble links every reference, like the bubble that replaces it", async () => {
  const entry: OutboxEntry = { id: "o1", text: SAMPLE, images: 0, at: 0, state: "queued" };
  await render(
    <OutboxBubblesView entries={[entry]} t={translator("en")} onCancel={() => {}} onRetry={() => {}} />,
  );
  expect(renderedLinks()).toEqual(HREFS);
});
