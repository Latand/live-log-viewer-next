import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftAgentPane } from "./DraftAgentPane";

/* SSR runs no effects and has no sessionStorage, so the pane renders in its
   fresh `draft` phase: the composer is live and no frozen launch bubble shows.
   The frozen phases are covered by DraftLaunchStatus.render.test.tsx and the
   lifecycle logic by draftSpawn.test.ts. */
test("a fresh draft renders the composer with no frozen launch status", () => {
  const html = renderToStaticMarkup(
    <DraftAgentPane draftId="d1" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />,
  );
  expect(html).toContain("Draft of a new agent conversation");
  /* The new-conversation hint marks the draft (composing, not launched) phase. */
  expect(html).toContain("Choose an engine and a directory");
  /* The composer's send affordance is present (draft is the only sendable phase). */
  expect(html).toContain('aria-label="Launch the agent"');
  /* No frozen launch status while composing — none of the lifecycle copy shows. */
  expect(html).not.toContain("waiting for the conversation");
  expect(html).not.toContain("may already be running");
});
