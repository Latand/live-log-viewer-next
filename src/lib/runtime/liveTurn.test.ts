import { expect, test } from "bun:test";

import {
  appendRuntimeLiveTurnDelta,
  completeRuntimeLiveTurnItem,
  normalizeRuntimeLiveTurn,
  projectRuntimeLiveTurnItem,
  runtimeLiveTurnItems,
} from "./liveTurn";

test("issue 626: bounded overflow preserves every unclaimed response identity across item and text limits", () => {
  let live = null;
  for (let index = 0; index < 40; index += 1) {
    const text = `${String(index).padStart(2, "0")}:${"x".repeat(2_045)}`;
    live = appendRuntimeLiveTurnDelta(live, `turn-${index}`, text, `2026-07-23T09:00:${String(index).padStart(2, "0")}.000Z`);
    live = completeRuntimeLiveTurnItem(live, `turn-${index}`, {
      type: "agentMessage",
      id: `response-${index}`,
      text,
    }, `2026-07-23T09:01:${String(index).padStart(2, "0")}.000Z`);
  }

  const items = runtimeLiveTurnItems(live);
  expect(items.map((item) => item.itemId)).toEqual(
    Array.from({ length: 40 }, (_, index) => `response-${index}`),
  );
  expect(live?.items).toHaveLength(32);
  expect(live?.overflow).toHaveLength(8);
  expect(items.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0))
    .toBeLessThanOrEqual(64 * 1024);
  expect(items.reduce((total, item) => total + (item.omittedChars ?? 0), 0)).toBeGreaterThan(0);

  /* Runtime journal snapshots serialize this shape. Re-normalization after a
     refresh retains every response once, in original order. */
  const refreshed = normalizeRuntimeLiveTurn(JSON.parse(JSON.stringify(live)));
  expect(runtimeLiveTurnItems(refreshed).map((item) => item.itemId))
    .toEqual(items.map((item) => item.itemId));
  expect(runtimeLiveTurnItems(refreshed).reduce(
    (total, item) => total + new TextEncoder().encode(item.text).length,
    0,
  ))
    .toBeLessThanOrEqual(64 * 1024);
});

test("issue 626: the text limit counts UTF-8 bytes", () => {
  const text = "ж".repeat(40_000);
  let live = appendRuntimeLiveTurnDelta(null, "turn-unicode", text);
  live = completeRuntimeLiveTurnItem(live, "turn-unicode", {
    type: "agentMessage",
    id: "response-unicode",
    text,
  });

  const [item] = runtimeLiveTurnItems(live);
  expect(new TextEncoder().encode(item?.text ?? "").length).toBeLessThanOrEqual(64 * 1024);
  expect(item?.omittedChars).toBeGreaterThan(0);
});

test("issue 626: completed text remains authoritative and exactly once after refresh replay", () => {
  const completed = (streamed: string, finalText: string, id: string) => {
    let live = appendRuntimeLiveTurnDelta(null, "turn-completion", streamed);
    live = completeRuntimeLiveTurnItem(live, "turn-completion", {
      type: "agentMessage",
      id,
      text: finalText,
    });
    live = completeRuntimeLiveTurnItem(live, "turn-completion", {
      type: "agentMessage",
      id,
      text: finalText,
    });
    return normalizeRuntimeLiveTurn(JSON.parse(JSON.stringify(live)));
  };

  expect(runtimeLiveTurnItems(completed("Hel", "Hello", "prefix"))).toEqual([
    expect.objectContaining({ itemId: "prefix", text: "Hello", phase: "awaiting-echo" }),
  ]);
  expect(runtimeLiveTurnItems(completed("Draft", "Rewritten final", "divergent"))).toEqual([
    expect.objectContaining({ itemId: "divergent", text: "Rewritten final", phase: "awaiting-echo" }),
  ]);
  expect(runtimeLiveTurnItems(completed("Keep streamed", "", "empty"))).toEqual([
    expect.objectContaining({ itemId: "empty", text: "Keep streamed", phase: "awaiting-echo" }),
  ]);
});

test("issue 626: the ultimate descriptor bound keeps a separate unclaimed summary", () => {
  let live = null;
  for (let index = 0; index < 550; index += 1) {
    const text = `response ${index}`;
    live = appendRuntimeLiveTurnDelta(live, `turn-${index}`, text);
    live = completeRuntimeLiveTurnItem(live, `turn-${index}`, {
      type: "agentMessage",
      id: `response-${index}`,
      text,
    });
  }

  const items = runtimeLiveTurnItems(live);
  expect(items).toHaveLength(544);
  expect(items[0]).toMatchObject({
    itemId: null,
    text: "",
    phase: "awaiting-echo",
    omittedItems: 7,
  });
  expect(items.slice(1).map((item) => item.itemId)).toEqual(
    Array.from({ length: 543 }, (_, index) => `response-${index + 7}`),
  );
});

test("issue 626: the ultimate summary counts fully text-trimmed unidentified commentary", () => {
  let live = null;
  for (let index = 0; index < 550; index += 1) {
    live = appendRuntimeLiveTurnDelta(
      live,
      `turn-unidentified-${index}`,
      `${index}:${"x".repeat(2_000)}`,
    );
  }

  const items = runtimeLiveTurnItems(live);
  expect(items).toHaveLength(544);
  expect(items[0]).toMatchObject({
    itemId: null,
    text: "",
    omittedItems: 7,
  });
  expect(items[0]?.omittedChars).toBeGreaterThan(0);
});

test("live tool items from Claude and Codex survive projection in response order under the text bound", () => {
  let live = appendRuntimeLiveTurnDelta(
    null,
    "turn-tools",
    "Checking the relevant files.",
    "2026-08-06T09:00:00.000Z",
  );
  live = completeRuntimeLiveTurnItem(live, "turn-tools", {
    type: "assistant",
    uuid: "claude-message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Checking the relevant files." },
        {
          type: "tool_use",
          id: "claude-read",
          name: "Read",
          input: { file_path: `src/${"nested/".repeat(12_000)}liveTurn.ts` },
        },
      ],
    },
  }, "2026-08-06T09:00:01.000Z");
  live = completeRuntimeLiveTurnItem(live, "turn-tools", {
    type: "commandExecution",
    id: "codex-command",
    command: "bun test src/lib/runtime/liveTurn.test.ts",
    cwd: "/repo",
  }, "2026-08-06T09:00:02.000Z");

  const items = runtimeLiveTurnItems(live);
  expect(items.map(({ kind, itemId, toolName }) => ({ kind, itemId, toolName }))).toEqual([
    { kind: "assistant", itemId: "claude-message", toolName: undefined },
    { kind: "tool", itemId: "claude-read", toolName: "Read" },
    { kind: "tool", itemId: "codex-command", toolName: "exec_command" },
  ]);
  expect(items.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0))
    .toBeLessThanOrEqual(64 * 1024);
  expect(items[1]?.omittedChars).toBeGreaterThan(0);
  expect(items[2]?.text).toContain("bun test src/lib/runtime/liveTurn.test.ts");
  expect(live?.text).toBe(items.findLast((item) => item.kind === "assistant")?.text);
  expect(live?.text).not.toContain("bun test src/lib/runtime/liveTurn.test.ts");
});

test("a Codex tool start appears immediately and completion updates the same live row", () => {
  const started = projectRuntimeLiveTurnItem(null, "turn-started-tool", {
    type: "commandExecution",
    id: "command-live",
    command: "bun test src/lib/runtime/liveTurn.test.ts",
    cwd: "/repo",
  }, "started", "2026-08-06T09:10:00.000Z");
  expect(runtimeLiveTurnItems(started)).toEqual([
    expect.objectContaining({
      kind: "tool",
      itemId: "command-live",
      toolName: "exec_command",
      phase: "streaming",
      startedAt: "2026-08-06T09:10:00.000Z",
      completedAt: null,
    }),
  ]);

  const completed = projectRuntimeLiveTurnItem(started, "turn-started-tool", {
    type: "commandExecution",
    id: "command-live",
    command: "bun test src/lib/runtime/liveTurn.test.ts",
    cwd: "/repo",
    status: "completed",
  }, "completed", "2026-08-06T09:10:01.000Z");
  expect(runtimeLiveTurnItems(completed)).toEqual([
    expect.objectContaining({
      kind: "tool",
      itemId: "command-live",
      phase: "awaiting-echo",
      startedAt: "2026-08-06T09:10:00.000Z",
      completedAt: "2026-08-06T09:10:01.000Z",
    }),
  ]);
});
