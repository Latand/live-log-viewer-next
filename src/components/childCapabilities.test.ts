import { expect, test } from "bun:test";
import { projectStructuredFileLiveness } from "@/lib/runtime/livenessProjection";
import { childControlFixture } from "@/lib/runtime/childControl.fixture";
import { agentCapabilitiesFromViews } from "./useAgentCapabilities";

for (const includeRoot of [true, false]) test(`production child ownership with root selected: ${includeRoot}`, async () => {
  const { registry, root, child, stale } = childControlFixture();
  const identity = { path: child.path, conversationId: child.conversationId, parent: child.parent, pid: null, proc: null };
  await projectStructuredFileLiveness(includeRoot ? [root, child] : [child], registry);
  expect(child).toMatchObject(identity);
  expect(child.controlHost).toBeUndefined();
  expect(child.rootControlHost).toEqual({ conversationId: root.conversationId!, parentPath: root.path, transport: "legacy" });
  const result = agentCapabilitiesFromViews(child, null, stale, true);
  expect(result.caps.surface).toBe("live-subagent");
  expect(result.caps.controls.stop.state).toBe("enabled");
  expect(result.caps.controls.compact.state).toBe("disabled");
  expect(result.caps.controls.runtime.state).toBe("hidden");
  expect(result.structuredSession).toBeNull();
});

test("aliases and historical parent paths resolve the current root generation", async () => {
  const { registry, root, child, stale } = childControlFixture();
  const snapshot = registry.readOnlySnapshot();
  const parent = snapshot.conversations[root.conversationId!]!;
  const original = parent.generations.at(-1)!;
  const current = { ...original, id: "current-generation", path: "/fixture/current-root.jsonl" };
  parent.generations.push(current);
  const entry = snapshot.entries[`claude:${original.id}`]!;
  snapshot.entries[`claude:${current.id}`] = { ...entry, key: { engine: "claude", sessionId: current.id }, artifactPath: current.path };
  entry.host = null;
  entry.status = "dead";
  snapshot.conversationAliases.conversation_old_child = snapshot.conversations[child.conversationId!]!.id;
  snapshot.conversationAliases.conversation_old_root = parent.id;
  snapshot.conversations[child.conversationId!]!.generations.at(-1)!.launchProfile.parentConversationId = "conversation_old_root";
  child.conversationId = "conversation_old_child";
  await projectStructuredFileLiveness([child], registry, snapshot);
  expect(child.rootControlHost).toEqual({ conversationId: parent.id, parentPath: root.path, transport: "legacy" });
  expect(child.conversationId).toBe("conversation_old_child");
  expect(agentCapabilitiesFromViews(child, null, stale, true).caps.controls.stop.state).toBe("enabled");
});

const refusals = ["dead", "unhosted", "pending", "missing-root", "superseded-root", "superseded-child", "wrong-identity", "wrong-parent", "independent-child", "ambiguous-pane", "ambiguous-path", "wrong-generation", "structured-only"] as const;
for (const refusal of refusals) test(`no legacy child override for ${refusal}`, async () => {
  const { registry, root, child, stale } = childControlFixture();
  await projectStructuredFileLiveness([child], registry);
  expect(child.rootControlHost).toBeDefined();
  const snapshot = registry.readOnlySnapshot();
  const parent = snapshot.conversations[root.conversationId!]!;
  const selected = snapshot.conversations[child.conversationId!]!;
  const entry = snapshot.entries[`claude:${parent.generations.at(-1)!.id}`]!;
  if (refusal === "dead" || refusal === "unhosted") entry.status = refusal;
  if (refusal === "pending") entry.pendingAction = "resume";
  if (refusal === "missing-root") delete snapshot.conversations[parent.id];
  if (refusal === "superseded-root") parent.supersededBy = { conversationId: "conversation_successor", at: "2026-09-01", reason: "stage-retry" };
  if (refusal === "superseded-child") selected.supersededBy = { conversationId: "conversation_successor", at: "2026-09-01", reason: "stage-retry" };
  if (refusal === "wrong-identity") child.conversationId = parent.id;
  if (refusal === "wrong-parent") selected.generations.at(-1)!.launchProfile.parentConversationId = "conversation_other";
  if (refusal === "independent-child") snapshot.lineageEdges[selected.id]!.source = "viewer-spawn";
  if (refusal === "ambiguous-pane" || refusal === "ambiguous-path") snapshot.entries["claude:conflict"] = { ...entry, key: { engine: "claude", sessionId: "conflict" }, artifactPath: refusal === "ambiguous-pane" ? "/fixture/other.jsonl" : entry.artifactPath, host: { ...entry.host!, paneId: refusal === "ambiguous-pane" ? entry.host!.paneId : "%other" } };
  if (refusal === "wrong-generation") entry.key = { engine: "claude", sessionId: "wrong" };
  if (refusal === "structured-only") entry.host = null;
  await projectStructuredFileLiveness([child], registry, snapshot);
  expect(child.rootControlHost).toBeUndefined();
  expect(agentCapabilitiesFromViews(child, null, stale, true).caps.controls.stop.state).toBe("hidden");
});

test("changing the scanner parent cannot reuse the preceding root projection", async () => {
  const { registry, child, stale } = childControlFixture();
  await projectStructuredFileLiveness([child], registry);
  child.parent = "/fixture/unrelated.jsonl";
  expect(agentCapabilitiesFromViews(child, null, stale, true).caps.controls.stop.state).toBe("hidden");
});
