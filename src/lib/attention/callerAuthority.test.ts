import { expect, test } from "bun:test";

import { attentionCallerAuthority, processAncestry, type AttentionCallerSources, type HostedConversation } from "./callerAuthority";

/*
 * Who may ask for the operator's screen (#688 D4).
 *
 * The caller is identified from two things it cannot restate: this process's
 * ancestry, and the host process ids the registry recorded when it launched each
 * conversation. An MCP server is a child of the agent that started it, so
 * walking up from here reaches that agent — and the registry says whose it is.
 */

const ROOT: HostedConversation = { conversationId: "conversation_root", pids: [100], role: "root" };
const REVIEWER: HostedConversation = { conversationId: "conversation_reviewer", pids: [200], role: "reviewer" };

function sources(overrides: Partial<AttentionCallerSources> = {}): AttentionCallerSources {
  return {
    ancestry: () => [900, 100],
    hosted: () => [ROOT, REVIEWER],
    rootConversationId: () => "conversation_root",
    ...overrides,
  };
}

test("the operator's own session is recognised through its agent process", () => {
  expect(attentionCallerAuthority(sources())).toEqual({ kind: "root", conversationId: "conversation_root" });
});

test("a worker is named rather than mistaken for the root", () => {
  const authority = attentionCallerAuthority(sources({ ancestry: () => [901, 200] }));

  expect(authority).toEqual({ kind: "worker", conversationId: "conversation_reviewer", role: "reviewer" });
});

test("the nearest hosted ancestor wins, so a worker under the root's tree is still a worker", () => {
  /* A worker started from a pane the root also owns has BOTH in its ancestry.
     The conversation actually running this tool is the closest one — reading the
     outermost would hand every descendant the operator's own authority. */
  const authority = attentionCallerAuthority(sources({ ancestry: () => [902, 200, 100] }));

  expect(authority).toEqual({ kind: "worker", conversationId: "conversation_reviewer", role: "reviewer" });
});

test("the adopted root lineage outranks the launch-profile role", () => {
  /* The lineage names the identity requests are actually written against. When
     it names a conversation, that conversation is the root even if another one
     still carries a stale `root` on its profile — otherwise a rolled-over root
     would leave two sessions both able to speak as the operator. */
  const stale: HostedConversation = { conversationId: "conversation_old_root", pids: [300], role: "root" };
  const authority = attentionCallerAuthority(sources({
    ancestry: () => [903, 300],
    hosted: () => [ROOT, stale],
  }));

  expect(authority).toEqual({ kind: "worker", conversationId: "conversation_old_root", role: "root" });
});

test("with no lineage adopted yet the launch-profile role decides", () => {
  expect(attentionCallerAuthority(sources({ rootConversationId: () => null })))
    .toEqual({ kind: "root", conversationId: "conversation_root" });
  expect(attentionCallerAuthority(sources({ rootConversationId: () => null, ancestry: () => [200] })))
    .toEqual({ kind: "worker", conversationId: "conversation_reviewer", role: "reviewer" });
});

test("an ancestry that matches no recorded host is unidentified, never assumed", () => {
  expect(attentionCallerAuthority(sources({ ancestry: () => [901, 902] }))).toEqual({ kind: "unidentified" });
  /* And a registry with nothing hosted at all says the same thing rather than
     falling through to "must be the root, then". */
  expect(attentionCallerAuthority(sources({ hosted: () => [] }))).toEqual({ kind: "unidentified" });
});

test("a conversation with no role recorded is still not the root", () => {
  const legacy: HostedConversation = { conversationId: "conversation_legacy", pids: [400], role: null };
  const authority = attentionCallerAuthority(sources({
    ancestry: () => [400],
    hosted: () => [legacy],
    rootConversationId: () => null,
  }));

  expect(authority).toEqual({ kind: "worker", conversationId: "conversation_legacy", role: null });
});

test("the ancestry walk stops at the root of the tree, a cycle, and its own bound", () => {
  const parents = new Map([[50, 40], [40, 30], [30, 1]]);
  expect(processAncestry(50, (pid) => parents.get(pid) ?? null)).toEqual([50, 40, 30]);

  /* A malformed ppid chain must not spin: bounded by the visited set. */
  const cycle = new Map([[10, 11], [11, 10]]);
  expect(processAncestry(10, (pid) => cycle.get(pid) ?? null)).toEqual([10, 11]);

  /* And a very deep tree is bounded by the hop limit rather than walked to the
     top of the machine on every tool call. */
  expect(processAncestry(1_000, (pid) => pid - 1, 4)).toEqual([1_000, 999, 998, 997]);
});
