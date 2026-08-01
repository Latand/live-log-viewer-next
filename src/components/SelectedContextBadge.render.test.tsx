import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { SelectedContextBadge } from "./SelectedContextBadge";

/**
 * The compact badge (#844 §render). It says one thing — which card this turn
 * points at — in a form the operator can read at a glance and a screen reader
 * can read at all. Rendered twice from the SAME component: in the composer
 * before admission, and on the persisted transcript row afterwards, so the two
 * cannot drift.
 */

const NOW = Date.parse("2026-07-31T09:00:00.000Z");
const IDENTITY = { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" };

function reference(overrides: { label?: string; project?: string | null } = {}): SelectedContextRef {
  return captureSelectedContext({
    context: { project: overrides.project === undefined ? "atlas" : overrides.project },
    slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
    cards: [{
      path: "fixtures/projects/atlas/worker-a.jsonl",
      conversationId: "conversation_atlas_a",
      ...(overrides.label === undefined ? { label: "Worker A" } : { label: overrides.label }),
    }],
    identity: IDENTITY,
    revision: 1,
    now: NOW,
  });
}

const empty = (): SelectedContextRef => captureSelectedContext({
  context: { project: "atlas" },
  slice: { focusedPath: null, selectedPaths: [] },
  cards: [],
  identity: IDENTITY,
  revision: 2,
  now: NOW,
});

test("a selected card renders its label and an accessible description", () => {
  setLocale("en");
  const html = renderToStaticMarkup(<SelectedContextBadge reference={reference()} />);
  expect(html).toContain("Worker A");
  expect(html).toMatch(/aria-label="[^"]*Worker A[^"]*"/);
});

test("an explicit empty selection renders its own visible state, not nothing", () => {
  setLocale("en");
  const html = renderToStaticMarkup(<SelectedContextBadge reference={empty()} />);
  expect(html).toContain("Nothing selected");
  expect(html).toMatch(/aria-label="[^"]*"/);
});

test("a card the view could only name by id still identifies itself", () => {
  setLocale("en");
  const html = renderToStaticMarkup(<SelectedContextBadge reference={reference({ label: "" })} />);
  expect(html).toContain("conversation_atlas_a");
});

test("no reference renders nothing at all", () => {
  expect(renderToStaticMarkup(<SelectedContextBadge reference={null} />)).toBe("");
});

test("a stale reference is marked, and says so in its accessible text", () => {
  setLocale("en");
  const html = renderToStaticMarkup(<SelectedContextBadge reference={reference()} stale />);
  expect(html.toLowerCase()).toContain("stale");
});

test("Ukrainian renders translated copy for both states", () => {
  setLocale("uk");
  const selected = renderToStaticMarkup(<SelectedContextBadge reference={reference()} />);
  const none = renderToStaticMarkup(<SelectedContextBadge reference={empty()} />);
  setLocale("en");
  expect(selected).toContain("Worker A");
  expect(selected).not.toContain("Selected card");
  expect(none).not.toContain("Nothing selected");
  expect(none).toMatch(/[Ѐ-ӿ]/);
});

test("the badge never renders transcript content — it has none to render", () => {
  setLocale("en");
  const html = renderToStaticMarkup(<SelectedContextBadge reference={reference()} />);
  expect(html).not.toContain("fixtures/projects/atlas/worker-a.jsonl");
});
