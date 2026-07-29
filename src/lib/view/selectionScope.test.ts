/**
 * The consumer half of the #771 selection contract.
 *
 * The publication half lives in the client: three publishers reporting one lifted
 * set. This asserts what the orchestrator gets back — given a view session whose
 * mode is `list` or `mobile-focus` and whose selectedPaths are non-empty, the
 * snapshot returns those conversations AND their content.
 *
 * `scopedPaths` and `validateExplicitMembership` in snapshot.ts already read
 * `selectedPaths` without caring which mode reported them, so NOTHING in
 * snapshot.ts changed for #771. This file pins that down, so a later edit cannot
 * quietly turn `selected` into a scheme-only scope.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import { resetPresenceForTest, upsertPresence } from "./presenceStore";
import { composeSnapshot } from "./snapshot";
import type { PresencePayloadV1 } from "./types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-selection-scope-"));
/* The presence store is module state shared by every test file in the process.
   Clearing it on BOTH sides means a session another file left behind cannot win
   `choose()` over the one under test, and this file leaves nothing behind either. */
beforeEach(() => resetPresenceForTest());
afterEach(() => resetPresenceForTest());

function presence(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1, viewSessionId: "selection-scope-view", deviceId: "selection-scope-device", device: { kind: "desktop", browser: "chrome" },
    visibility: "visible", sequence: 1, inputSequence: 1, project: "viewer", mode: "scheme",
    viewport: { width: 100, height: 100, dpr: 1 }, camera: null, focusedPath: null, selectedPaths: [], visiblePaths: [],
    board: { renderedRevision: 1, durableRevision: 1, sync: "current" }, ...overrides,
  };
}
function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname, root: "claude-projects", name: path.basename(pathname), project: "viewer", title: pathname,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "idle",
    proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...overrides,
  };
}

describe("selection made OUTSIDE scheme mode reaches the snapshot (#771)", () => {
  function withText(name: string, body: string): string {
    const pathname = path.join(sandbox, name);
    fs.writeFileSync(pathname, JSON.stringify({ type: "assistant", timestamp: "t", message: { content: [{ type: "text", text: body }] } }) + "\n");
    return pathname;
  }

  test("scope selected returns the selected conversations' content from list mode", async () => {
    const one = withText("list-selected-one.jsonl", "the first selected conversation");
    const two = withText("list-selected-two.jsonl", "the second selected conversation");
    const other = withText("list-unselected.jsonl", "not selected at all");
    /* A list-mode session: no camera, rows as visiblePaths, and the operator's
       selection carried in the order the LIST renders. */
    upsertPresence(presence({ mode: "list", camera: null, focusedPath: null, selectedPaths: [one, two], visiblePaths: [one, two, other] }), 1000);

    const result = await composeSnapshot({
      request: { schemaVersion: 1, scope: { kind: "selected" } },
      files: [file(one), file(two), file(other)],
      siblings: { selfResolution: "omitted", agents: [] },
      scannerDurationMs: 0,
      now: 2000,
    });

    expect(result.view.mode).toBe("list");
    expect(result.view.selectedPaths).toEqual([one, two]);
    expect(result.scope).toMatchObject({ kind: "selected", totalPaths: 2, returnedPaths: [one, two], truncated: false });
    /* Requirement (c): the CONTENT of the selected conversations, not just names. */
    const bodies = result.conversations.flatMap((item) => item.text?.messages.map((message) => message.text) ?? []);
    expect(bodies.join("\n")).toContain("the first selected conversation");
    expect(bodies.join("\n")).toContain("the second selected conversation");
    expect(bodies.join("\n")).not.toContain("not selected at all");
  });

  test("focused-selected and explicit paths admit a mobile-focus selection too", async () => {
    const focused = withText("phone-focused.jsonl", "the pinned pane");
    const selected = withText("phone-selected.jsonl", "the selected card");
    upsertPresence(presence({ mode: "mobile-focus", camera: null, focusedPath: focused, selectedPaths: [selected], visiblePaths: [focused] }), 1000);

    const both = await composeSnapshot({
      request: { schemaVersion: 1, scope: { kind: "focused-selected" }, text: { include: false } },
      files: [file(focused), file(selected)],
      siblings: { selfResolution: "omitted", agents: [] },
      scannerDurationMs: 0,
      now: 2000,
    });
    expect(both.scope.returnedPaths).toEqual([focused, selected]);

    /* A selected path is part of the current view even when this view does not
       render it, so naming it explicitly is admitted rather than rejected. */
    const explicit = await composeSnapshot({
      request: { schemaVersion: 1, scope: { kind: "paths", paths: [selected] }, text: { include: false } },
      files: [file(focused), file(selected)],
      siblings: { selfResolution: "omitted", agents: [] },
      scannerDurationMs: 0,
      now: 2000,
    });
    expect(explicit.scope.returnedPaths).toEqual([selected]);
  });

  test("an empty selection yields an empty selected scope rather than a fallback", async () => {
    const only = withText("no-selection.jsonl", "visible but unselected");
    upsertPresence(presence({ mode: "list", camera: null, focusedPath: null, selectedPaths: [], visiblePaths: [only] }), 1000);
    const result = await composeSnapshot({
      request: { schemaVersion: 1, scope: { kind: "selected" }, text: { include: false } },
      files: [file(only)],
      siblings: { selfResolution: "omitted", agents: [] },
      scannerDurationMs: 0,
      now: 2000,
    });
    expect(result.scope).toMatchObject({ kind: "selected", totalPaths: 0, returnedPaths: [] });
    expect(result.conversations).toEqual([]);
  });
});
