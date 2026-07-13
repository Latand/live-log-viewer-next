import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WakeupEventInfo } from "../parse";
import { WakeupCard } from "./WakeupCard";

const FUTURE = Date.now() + 20 * 60 * 1000;
const PAST = Date.now() - 20 * 60 * 1000;

function info(over: Partial<WakeupEventInfo> = {}): WakeupEventInfo {
  return { fireAt: FUTURE, delaySeconds: 1200, reason: "Fallback poll", prompt: "Continue the issue", superseded: false, ...over };
}

test("an active wakeup renders the reason, an absolute time and a countdown", () => {
  const html = renderToStaticMarkup(<WakeupCard wakeup={info()} />);
  expect(html).toContain("Fallback poll");
  expect(html).toContain("wakes at");
  expect(html).toContain("in ");
  // The plan (prompt) is present behind its expander.
  expect(html).toContain("Continue the issue");
  expect(html).toContain("wake plan");
});

test("a superseded wakeup renders the quiet past state, not a live countdown", () => {
  const html = renderToStaticMarkup(<WakeupCard wakeup={info({ superseded: true })} />);
  expect(html).toContain("superseded");
});

test("an elapsed wakeup renders the fired state", () => {
  const html = renderToStaticMarkup(<WakeupCard wakeup={info({ fireAt: PAST })} />);
  expect(html).toContain("fired at");
});

test("a wakeup without a fire time still shows its reason and plan", () => {
  const html = renderToStaticMarkup(<WakeupCard wakeup={info({ fireAt: null })} />);
  expect(html).toContain("Fallback poll");
  expect(html).toContain("Continue the issue");
});
