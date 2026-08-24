import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TFunction } from "@/lib/i18n";
import type { StructuredSpawnCardState } from "@/lib/types";

import { LaunchChipsView } from "./LaunchChips";

const t: TFunction = (key, params) => translate("en", key, params);

const LAUNCH_ID = "launch_4d61b7c8";

function launch(
  state: StructuredSpawnCardState["state"],
  overrides: Partial<StructuredSpawnCardState> = {},
): StructuredSpawnCardState {
  return {
    launchId: LAUNCH_ID,
    clientAttemptId: null,
    accountId: "work",
    conversationId: "conversation_1138",
    state,
    initialMessage: "delivered",
    retrySafe: false,
    error: null,
    ...overrides,
  };
}

test("issue 1138: a failed launch keeps the launch id beside its error and retry", () => {
  const html = renderToStaticMarkup(
    <LaunchChipsView
      launch={launch("failed", { initialMessage: "failed", retrySafe: true, error: "host never bound" })}
      t={t}
      onRetry={() => {}}
    />,
  );

  /* The id is the handle an operator quotes when chasing a launch that never
     became a conversation, so failure keeps it — with the error and Retry. */
  expect(html).toContain('data-launch-chip="id"');
  expect(html).toContain(LAUNCH_ID.slice(0, 8));
  expect(html).toContain("host never bound");
  expect(html).toContain("data-launch-retry");
});

test("issue 1138: a launch that worked shows no launch id", () => {
  for (const state of ["recovered", "live-late-success"] as const) {
    const html = renderToStaticMarkup(<LaunchChipsView launch={launch(state)} t={t} />);

    expect(html).not.toContain('data-launch-chip="id"');
    expect(html).not.toContain(LAUNCH_ID.slice(0, 8));
    /* Everything else about the row is unchanged: state and first-message
       chips still carry their full sentence. */
    expect(html).toContain(`data-launch-state="${state}"`);
    expect(html).toContain('data-launch-chip="state"');
    expect(html).toContain('data-launch-chip="initial"');
  }
});

test("issue 1138: a launch still being chased keeps its launch id", () => {
  /* Pre-adoption and settling states are unchanged by #1138: the id is the
     handle an operator quotes while the launch has no conversation to point
     at yet, so every in-progress state keeps it exactly as before. */
  for (const state of ["starting", "binding", "queued", "reconciling", "recoverable-timeout"] as const) {
    const html = renderToStaticMarkup(<LaunchChipsView launch={launch(state)} t={t} />);

    expect(html).toContain('data-launch-chip="id"');
    expect(html).toContain(LAUNCH_ID.slice(0, 8));
    expect(html).toContain(`data-launch-state="${state}"`);
    expect(html).toContain('data-launch-chip="state"');
    expect(html).toContain('data-launch-chip="initial"');
  }
});
