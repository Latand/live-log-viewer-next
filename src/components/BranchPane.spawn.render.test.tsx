import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { BranchPane } from "./BranchPane";

const file: FileEntry = {
  path: "spawn:9173e9a2-2f14-4a70-818a-bd4052a1ad4a",
  root: "codex-sessions",
  name: "spawn:9173e9a2-2f14-4a70-818a-bd4052a1ad4a",
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
    launchId: "9173e9a2-2f14-4a70-818a-bd4052a1ad4a",
    clientAttemptId: "p0_282_spawn_visibility_20260716_a1",
    accountId: "terra",
    state: "queued",
    initialMessage: "queued",
    retrySafe: false,
    error: null,
  },
};

test("a preallocated branch pane shows launch status without transcript actions", () => {
  const html = renderToStaticMarkup(<BranchPane file={file} tasks={[]} isRoot />);

  expect(html).toContain('data-spawn-state="queued"');
  expect(html).toContain("@ terra");
  expect(html).not.toContain("Delete the conversation from disk");
  expect(html).not.toContain("textarea");
});

test("an owner action renders in the native pane header", () => {
  const html = renderToStaticMarkup(
    <BranchPane
      file={file}
      tasks={[]}
      isRoot={false}
      headerActions={<button data-owner-header-action>collapse</button>}
    />,
  );

  expect(html).toContain("data-owner-header-action");
  expect(html.indexOf("data-owner-header-action")).toBeLessThan(html.indexOf("data-spawn-state"));
});
