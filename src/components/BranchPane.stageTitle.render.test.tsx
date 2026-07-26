import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { BranchPane } from "./BranchPane";

/*
 * A pipeline stage's live pane is titled by its place in the chain (#658). The
 * scanner titles a conversation by the first line of its opening prompt, and
 * every stage prompt opens with the same shared safety preamble — so every stage
 * pane on the board carried the identical meaningless title. The owner imposes
 * the identity instead; the transcript's own title stays in the tooltip.
 */

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/stage.jsonl", root: "claude-projects", name: "stage.jsonl", project: "viewer",
    title: "Work alone and launch no helpers, workflows, teams or subagents.",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "live",
    proc: "running", pid: 5, model: "sonnet", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

test("a titleOverride names the pane and keeps the transcript's own title in the tooltip", () => {
  const html = renderToStaticMarkup(
    <BranchPane file={file()} tasks={[]} isRoot titleOverride="Builder · integrate_v3_voice · stage 2/3" />,
  );
  expect(html).toContain("Builder · integrate_v3_voice · stage 2/3");
  expect(html).toContain("data-pane-title-override");
  /* Reachable, not lost: the prompt-derived title rides the header tooltip. */
  expect(html).toMatch(/title="Builder · integrate_v3_voice · stage 2\/3 — Work alone and launch no helpers/);
});

test("a renamable stage pane shows the imposed title and drops the inline rename pencil, by design", () => {
  /* A renamable conversation would otherwise render the editable SessionTitle
     seeded from the prompt-derived title — the very string #658 is about. The
     imposed identity replaces that editor, so the card carries no rename pencil;
     renaming stays reachable through F2 → the full-window overlay, which drops
     the override while a rename token is pending (SchemeBoard `stageTitle`,
     `titleUnderRename`). Losing the pencil here is a decision, not a slip. */
  const stagePane = renderToStaticMarkup(
    <BranchPane file={file({ renamable: true } as Partial<FileEntry>)} tasks={[]} isRoot titleOverride="Architect · plan_v3_voice · stage 1/3" />,
  );
  expect(stagePane).toContain("Architect · plan_v3_voice · stage 1/3");
  expect(stagePane).not.toContain("Rename ");

  /* The same conversation without an override keeps its editor: the pencil is
     lost only where an owner imposes an identity. */
  const plainPane = renderToStaticMarkup(<BranchPane file={file({ renamable: true } as Partial<FileEntry>)} tasks={[]} isRoot />);
  expect(plainPane).toContain("Rename ");
});

test("without an override the pane keeps the transcript-derived title (every other surface)", () => {
  const html = renderToStaticMarkup(<BranchPane file={file({ title: "Plain conversation" })} tasks={[]} isRoot />);
  expect(html).toContain("Plain conversation");
  expect(html).not.toContain("data-pane-title-override");
});
