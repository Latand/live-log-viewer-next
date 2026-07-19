import { describe, expect, test } from "bun:test";

import { describeMcpCall } from "./presentation";

describe("describeMcpCall", () => {
  test("describes a spawned reviewer and links its durable conversation", () => {
    expect(describeMcpCall("spawn_agent", {
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      role: "reviewer",
      "prompt": "Review PR #431",
    }, {
      conversationId: "conversation_431",
      transcriptPath: "/sessions/reviewer.jsonl",
    })).toEqual({
      icon: "bot",
      verb: "Creating",
      title: "Creating agent: gpt-5.6-sol xhigh reviewer · Review PR #431",
      subtitle: "/sessions/reviewer.jsonl",
      links: [{
        kind: "conversation",
        id: "conversation_431",
        label: "Open agent",
        href: "#c=conversation_431",
      }],
    });
  });

  test("gives every v1 tool its own action sentence and icon", () => {
    const cases = [
      ["send_message", { conversationId: "conversation_a", text: "Ship the fix" }, "message", "Sending message"],
      ["create_task", { project: "viewer", text: "Audit MCP cards" }, "task", "Creating task"],
      ["update_task", { taskId: "task-a", status: "done" }, "task", "Updating task"],
      ["create_pipeline", { task: "Ship MCP", repoDir: "/repo" }, "pipeline", "Creating pipeline"],
      ["pipeline_action", { pipelineId: "pipe-a", action: "resume" }, "pipeline", "Resuming pipeline"],
      ["link_task_to_pipeline", { taskId: "task-a", pipelineId: "pipe-a" }, "link", "Linking task to pipeline"],
      ["list_conversations", { project: "viewer" }, "conversation", "Listing conversations"],
      ["get_conversation", { conversationId: "conversation_a" }, "conversation", "Opening conversation"],
      ["deploy_exact_sha", { revision: "abcdef1234567890", confirm: "deploy" }, "deploy", "Deploying revision"],
      ["get_pipeline", { pipelineId: "pipe-a" }, "pipeline", "Opening pipeline"],
    ] as const;

    for (const [tool, args, icon, prefix] of cases) {
      const description = describeMcpCall(tool, args);
      expect(description.icon).toBe(icon);
      expect(description.title.startsWith(prefix)).toBe(true);
      expect(description.verb.length).toBeGreaterThan(0);
    }
  });

  test("unknown tools use a stable generic fallback", () => {
    expect(describeMcpCall("future_tool", { payload: "x" })).toEqual({
      icon: "tool",
      verb: "Running",
      title: "Running MCP tool: future_tool",
      subtitle: "",
      links: [],
    });
  });
});
