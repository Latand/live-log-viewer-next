import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { OverviewBoard } from "./OverviewBoard";

/* Overview cards (issue #345): the project heading presents the display name
   while the card's click handler keeps the canonical key. Server render
   assumes the desktop grid; the mobile drawer variant of the same names is
   covered by ProjectRail.dom.test.tsx. */

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "-agents-tools-live-log-viewer-next",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

test("overview cards show display names, canonical keys never render as text", () => {
  const files = [
    fileEntry({ path: "/sessions/viewer.jsonl" }),
    /* A live branch whose title the server overlay already compacted from the
       raw spawn prompt: the card renders the compact role title. */
    fileEntry({ path: "/sessions/orch.jsonl", title: "Orchestrator", activity: "live" }),
    fileEntry({ path: "/sessions/plain.jsonl", project: "CelestiaCompose" }),
  ];
  const html = renderToStaticMarkup(
    <OverviewBoard
      files={files}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      now={2_000}
      onSelectProject={() => {}}
      onSelectFile={() => {}}
    />,
  );
  expect(html).toContain(">live-log-viewer-next<");
  expect(html).not.toContain("-agents-tools-live-log-viewer-next");
  expect(html).toContain("CelestiaCompose");
  expect(html).toContain("Orchestrator");
});
