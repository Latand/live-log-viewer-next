import { describe, expect, test } from "bun:test";

import {
  MAX_SNAPSHOT_CHARS_PER_CONVERSATION, MAX_SNAPSHOT_LAST_MESSAGES,
  SNAPSHOT_CALLER_KEYS, SNAPSHOT_SCOPE_KEYS, SNAPSHOT_TEXT_KEYS, SNAPSHOT_VIEW_KEYS, VIEW_SCOPE_KINDS,
} from "./types";
import { validateSnapshotRequest, ViewValidationError } from "./validation";

/**
 * Issue #774: the MCP tool schema published `z.record(z.string(), z.unknown())`
 * for every nested snapshot object while this validator enforced an exact key
 * set. A caller could not see the accepted keys in the schema, and the
 * rejection named only the key it guessed wrong — 119 calls in ten days died
 * that way. These pin both halves of the fix: one source of truth for the
 * accepted keys, and rejections that name the alternatives.
 */
describe("snapshot request allowlists (#774)", () => {
  test("an unknown nested key names the accepted alternatives", () => {
    for (const [field, body, allowed] of [
      ["text", { schemaVersion: 1, text: { mode: "digest" } }, SNAPSHOT_TEXT_KEYS],
      ["view", { schemaVersion: 1, view: { includeFrame: true } }, SNAPSHOT_VIEW_KEYS],
      ["scope", { schemaVersion: 1, scope: { kind: "visible", project: "x" } }, SNAPSHOT_SCOPE_KEYS],
      ["caller", { schemaVersion: 1, caller: { transcript: "x" } }, SNAPSHOT_CALLER_KEYS],
    ] as const) {
      let caught: unknown;
      try { validateSnapshotRequest(body); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ViewValidationError);
      const message = (caught as ViewValidationError).message;
      expect(message.startsWith(`unknown ${field}.`)).toBe(true);
      for (const key of allowed) expect(message).toContain(key);
    }
  });

  test("an invalid closed-set value names the accepted alternatives", () => {
    let caught: unknown;
    try { validateSnapshotRequest({ schemaVersion: 1, scope: { kind: "everything" } }); } catch (error) { caught = error; }
    expect((caught as ViewValidationError).message).toBe(`invalid scope.kind (allowed: ${VIEW_SCOPE_KINDS.join(", ")})`);
  });

  test("every key the published tool schema accepts is admitted by the validator", () => {
    /* The regression that matters is the two sides drifting apart again. */
    const request = validateSnapshotRequest({
      schemaVersion: 1,
      view: { id: "v", deviceId: "d", resolution: "latest-interaction" },
      scope: { kind: "paths", paths: ["/a.jsonl"] },
      text: { include: true, lastMessages: MAX_SNAPSHOT_LAST_MESSAGES, maxCharsPerConversation: MAX_SNAPSHOT_CHARS_PER_CONVERSATION },
      caller: { pid: 1, transcriptPath: "/t.jsonl" },
    });
    expect(Object.keys(request.view ?? {})).toEqual([...SNAPSHOT_VIEW_KEYS]);
    expect(Object.keys(request.text ?? {})).toEqual([...SNAPSHOT_TEXT_KEYS]);
    expect(Object.keys(request.caller ?? {})).toEqual([...SNAPSHOT_CALLER_KEYS]);
    expect(request.scope).toEqual({ kind: "paths", paths: ["/a.jsonl"] });
  });
});
