import { describe, expect, test } from "bun:test";

import { familyLabelKey, summarizeTool, TOOL_FAMILIES, type ToolFamily } from "./tools";

function sum(tool: string, args: Record<string, unknown>, engine: "claude" | "codex" = "claude") {
  return summarizeTool(tool, args, engine);
}

describe("family, icon, and summary per table row", () => {
  test("shell (Bash / Codex exec_command / plain)", () => {
    expect(sum("Bash", { command: "ls -la" }).family).toBe("shell");
    expect(sum("Bash", { command: "ls -la" }).icon).toBe("shell");
    expect(sum("exec_command", { cmd: "bun test" }, "codex").family).toBe("shell");
    expect(sum("shell", { command: "echo hi" }, "codex").family).toBe("shell");
    expect(sum("Bash", { command: "cd /repo && ls" }).summary).toContain("ls");
  });

  test("write_stdin — shows the keys sent and the session, as a shell card (#141)", () => {
    /* session_id arrives as a NUMBER; chars carries the actual bytes (^C here). */
    const s = sum("write_stdin", { session_id: 8479, chars: "" }, "codex");
    expect(s.family).toBe("shell");
    expect(s.icon).toBe("shell");
    expect(s.summary).toContain("8479");
    expect(s.summary).toContain("^C");
    expect(s.chips.some((c) => c.value === "8479")).toBe(true);
  });

  test("write_stdin — empty chars is labeled a poll, not an Enter keystroke (#141)", () => {
    const s = sum("write_stdin", { session_id: 12, chars: "" }, "codex");
    expect(s.summary).toContain("poll");
    expect(s.summary).not.toContain("⏎");
  });

  test("write_stdin — a space-only keystroke is shown, never mislabeled a poll (finding 2)", () => {
    const s = sum("write_stdin", { session_id: 12, chars: " " }, "codex");
    expect(s.summary).toContain("␠");
    expect(s.summary).not.toContain("poll");
  });

  test("wait — names the session/cell it is tailing, as a shell card (#141)", () => {
    const s = sum("wait", { cell_id: "46", yield_time_ms: 30000 }, "codex");
    expect(s.family).toBe("shell");
    expect(s.summary).toContain("46");
  });

  test("read", () => {
    const s = sum("Read", { file_path: "/repo/src/config.ts", offset: 10, limit: 30 });
    expect(s.family).toBe("read");
    expect(s.icon).toBe("file");
    expect(s.summary).toContain("config.ts");
    expect(s.summary).toContain("10");
  });

  test("write", () => {
    const s = sum("Write", { file_path: "/repo/src/route.ts", content: "a\nb\nc\nd" });
    expect(s.family).toBe("write");
    expect(s.icon).toBe("file");
    expect(s.summary).toContain("route.ts");
    expect(s.summary).toContain("4");
  });

  test("edit — single and multi-file counts", () => {
    const single = sum("Edit", { file_path: "/repo/a.ts", old_string: "x\ny", new_string: "X\nY\nZ" });
    expect(single.family).toBe("edit");
    expect(single.icon).toBe("edit");
    expect(single.summary).toContain("a.ts");
    expect(single.summary).toContain("+3");
    expect(single.summary).toContain("2");

    const patch = ["*** Begin Patch", "*** Add File: a.ts", "+1", "*** Update File: b.ts", "@@", "+2", "-3", "*** Delete File: c.ts", "*** End Patch"].join("\n");
    const multi = sum("apply_patch", { input: patch }, "codex");
    expect(multi.family).toBe("edit");
    expect(multi.summary).toContain("3");
  });

  test("search (Grep / Glob)", () => {
    const grep = sum("Grep", { pattern: "TODO", path: "src/" });
    expect(grep.family).toBe("search");
    expect(grep.icon).toBe("search");
    expect(grep.summary).toContain("TODO");
    expect(grep.summary).toContain("src/");
    expect(sum("Glob", { pattern: "**/*.ts" }).family).toBe("search");
  });

  test("web (WebFetch / WebSearch)", () => {
    const fetch = sum("WebFetch", { url: "https://example.com/docs/page?q=1" });
    expect(fetch.family).toBe("web");
    expect(fetch.icon).toBe("web");
    expect(fetch.summary).toContain("example.com");
    const search = sum("WebSearch", { query: "next.js app router" });
    expect(search.family).toBe("web");
    expect(search.summary).toContain("next.js app router");
  });

  test("spawn (Task / Agent / Workflow / Skill)", () => {
    const task = sum("Task", { subagent_type: "Explore", description: "map the parser" });
    expect(task.family).toBe("spawn");
    expect(task.icon).toBe("spawn");
    expect(task.summary).toContain("Explore");
    expect(task.summary).toContain("map the parser");
    expect(sum("Skill", { command: "code-review" }).family).toBe("spawn");
    expect(sum("Workflow", { name: "find-flaky" }).family).toBe("spawn");
  });

  test("plan (TodoWrite / TaskCreate / EnterPlanMode)", () => {
    expect(sum("TodoWrite", { todos: [{ content: "a" }, { content: "b" }] }).family).toBe("plan");
    expect(sum("TodoWrite", { todos: [] }).icon).toBe("plan");
    expect(sum("EnterPlanMode", {}).family).toBe("plan");
    expect(sum("TaskCreate", { subject: "ship it" }).summary).toContain("ship it");
  });

  test("mcp (mcp__server__tool)", () => {
    const s = sum("mcp__telegram__send_message", { text: "hello" });
    expect(s.family).toBe("mcp");
    expect(s.icon).toBe("tool");
    expect(s.summary).toContain("telegram");
    expect(s.summary).toContain("send_message");
  });

  test("unknown tool falls back to other", () => {
    const s = sum("SomeFutureTool", { thing: "value" });
    expect(s.family).toBe("other");
    expect(s.icon).toBe("tool");
    expect(s.summary).toContain("SomeFutureTool");
  });
});

describe("totality and safety", () => {
  test("every family has a label key", () => {
    for (const family of TOOL_FAMILIES) {
      expect(typeof familyLabelKey(family as ToolFamily)).toBe("string");
    }
  });

  test("never throws on malformed / empty / non-string args", () => {
    const inputs: Record<string, unknown>[] = [
      {},
      { command: 42 },
      { file_path: null },
      { pattern: { nested: true } },
      { url: ["array"] },
      { todos: "not-an-array" },
      { subagent_type: 999, description: undefined },
    ];
    for (const tool of ["Bash", "Read", "Write", "Edit", "Grep", "WebFetch", "Task", "TodoWrite", "mcp__x__y", "Weird"]) {
      for (const args of inputs) {
        expect(() => sum(tool, args)).not.toThrow();
        const s = sum(tool, args);
        expect(s.summary.length).toBeLessThanOrEqual(160);
        expect(s.chips.length).toBeLessThanOrEqual(4);
        for (const chip of s.chips) expect(chip.value.length).toBeLessThanOrEqual(120);
      }
    }
  });

  test("redacts secrets in summary and chips", () => {
    const s = sum("Bash", { command: "curl 'https://x?token=sk-SUPERSECRET'" });
    expect(s.summary).not.toContain("sk-SUPERSECRET");
    const web = sum("WebFetch", { url: "https://api.example.com?api_key=LEAKME12345" });
    expect(JSON.stringify(web)).not.toContain("LEAKME12345");
  });

  test("summary stays bounded for very long args", () => {
    const s = sum("Grep", { pattern: "x".repeat(5000), path: "y".repeat(5000) });
    expect(s.summary.length).toBeLessThanOrEqual(160);
  });
});
