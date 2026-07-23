import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { BranchPane } from "./BranchPane";

const file: FileEntry = {
  path: "spawn:launch_9173e9a2",
  root: "codex-sessions",
  name: "spawn:launch_9173e9a2",
  project: "live-log-viewer-next",
  title: "Builder",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 0,
  activity: "live",
  proc: null,
  pid: null,
  model: "gpt-5.4",
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_ac6029b9",
  spawn: {
    launchId: "launch_9173e9a2",
    clientAttemptId: "p0_282_spawn_visibility_20260716_a1",
    accountId: "terra",
    state: "queued",
    initialMessage: "queued",
    retrySafe: false,
    error: null,
  },
};

/** The live conversation that same launch became: one conversation id, a real
    transcript path, and the launch carried as transient facts (issue #569). */
const materialized: FileEntry = {
  ...file,
  path: "/home/user/.codex/sessions/rollout-live.jsonl",
  name: "rollout-live.jsonl",
  spawn: undefined,
  launch: { ...file.spawn!, state: "live-late-success", initialMessage: "delivered" },
};

test("issue 569: a queued launch renders the ordinary conversation window, not a status card", () => {
  const html = renderToStaticMarkup(<BranchPane file={file} tasks={[]} isRoot />);

  /* Same shell, same feed, same composer as a live conversation — the launch
     is a lifecycle state of this window, never a replacement for it. */
  expect(html).toContain("data-log-feed-scroller");
  expect(html).toContain("textarea");
  expect(html).toContain("data-agent-control-strip");
  /* The launch facts ride INSIDE the feed as compact chips. */
  expect(html).toContain('data-launch-chips="true"');
  expect(html).toContain('data-launch-state="queued"');
  expect(html).toContain('data-launch-initial="queued"');
  expect(html).toContain(translate("en", "spawnChip.queued"));
  expect(html).toContain("@ terra");
  /* A launch has no transcript on disk yet, so deleting one stays absent. */
  expect(html).not.toContain("Delete the conversation from disk");
});

test("issue 569: the materialized conversation keeps the launch as chips in the same window", () => {
  const html = renderToStaticMarkup(<BranchPane file={materialized} tasks={[]} isRoot />);

  expect(html).toContain('data-launch-state="live-late-success"');
  expect(html).toContain('data-launch-initial="delivered"');
  expect(html).toContain(translate("en", "spawnChip.live-late-success"));
  /* The placeholder wording the operator watched for three minutes while the
     agent was already running never appears on a delivered launch. */
  expect(html).not.toContain(translate("en", "spawnCard.queued"));
  expect(html).toContain("data-log-feed-scroller");
  expect(html).toContain("textarea");
});

test("an owner action renders in the native pane header, above the feed's launch chips", () => {
  const html = renderToStaticMarkup(
    <BranchPane
      file={file}
      tasks={[]}
      isRoot={false}
      headerActions={<button data-owner-header-action>collapse</button>}
    />,
  );

  expect(html).toContain("data-owner-header-action");
  expect(html.indexOf("data-owner-header-action")).toBeLessThan(html.indexOf("data-launch-chips"));
});
