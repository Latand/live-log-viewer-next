import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { BranchPane } from "./BranchPane";

/*
 * Desktop acceptance for issue #383: the REAL `BranchPane` wiring of the
 * superseded-round contract. A superseded card swaps its composer for the
 * banner that links the live successor; the successor card wears the lineage
 * chip deep-linking the retired round.
 */

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/round-1.jsonl", root: "claude-projects", name: "round-1.jsonl", project: "viewer", title: "builder round",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "idle",
    proc: "killed", pid: null, model: "fable", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
    conversationId: "conversation_round_1",
    ...over,
  } as FileEntry;
}

const SUPERSEDED = {
  conversationId: "conversation_round_2",
  path: "/round-2.jsonl",
  at: "2026-07-18T13:37:51.000Z",
  reason: "recovery-spawn",
};

test("a superseded card mounts the successor banner instead of the composer and dead-host recovery", () => {
  const html = renderToStaticMarkup(
    <BranchPane file={file({ supersededBy: SUPERSEDED, activityReason: "superseded" })} tasks={[]} isRoot />,
  );
  expect(html).toContain("data-superseded-banner");
  expect(html).not.toContain("data-dead-host-banner");
  expect(html).not.toContain("<textarea");
  expect(html.match(/data-strip-surface="([a-z-]+)"/)?.[1]).toBe("superseded");
});

test("the successor card wears the round lineage chip deep-linking its predecessor", () => {
  const html = renderToStaticMarkup(
    <BranchPane
      file={file({
        path: "/round-2.jsonl",
        conversationId: "conversation_round_2",
        activity: "live",
        proc: "running",
        pid: 7,
        continues: { conversationId: "conversation_round_1", path: "/round-1.jsonl", round: 2 },
      })}
      tasks={[]}
      isRoot
    />,
  );
  expect(html).toContain("data-continues-chip");
  expect(html).toContain("#c=conversation_round_1");
  expect(html).toContain("round 2");
  // still a fully live card: composer intact
  expect(html).toContain("<textarea");
});
