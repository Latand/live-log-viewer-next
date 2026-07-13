import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { loadDrafts } from "@/components/ProjectDashboard";

import { isWorkflowDraftId } from "./workflowModel";

/* A minimal in-memory sessionStorage: `loadDrafts` — the restore path shared by
   the desktop scheme and the mobile focus view — is the only thing under test,
   and it touches nothing else on `window`. */
class MemStorage {
  store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

const PROJECT = "demo";
const draftsKey = (project: string) => `llvDrafts:${project}`;
const wfField = (id: string, name: string) => `llvWfDraft:${id}:${name}`;
const WF_FIELDS = ["template", "dir", "task", "mode"];

const agentA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const agentB = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
  (globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = storage;
  /* A tab whose saved state predates the #136 workflow fencing: its draft list
     interleaves live agent drafts with two legacy `wf-*` workflow drafts, and
     every workflow draft still has its pane fields persisted. */
  storage.setItem(draftsKey(PROJECT), JSON.stringify([agentA, "wf-alpha", agentB, "wf-beta"]));
  for (const id of ["wf-alpha", "wf-beta"]) {
    for (const name of WF_FIELDS) storage.setItem(wfField(id, name), `${id}-${name}`);
  }
});

afterEach(() => {
  delete (globalThis as unknown as { sessionStorage?: MemStorage }).sessionStorage;
});

test("dashboard restore purges legacy workflow drafts, their pane fields, and rewrites the list (#136/#156)", () => {
  /* Sanity: the legacy fields exist before the restore runs. */
  expect(storage.getItem(wfField("wf-alpha", "template"))).toBe("wf-alpha-template");

  const restored = loadDrafts(PROJECT);

  /* The returned list keeps only the agent drafts, in order. */
  expect(restored).toEqual([agentA, agentB]);

  /* The persisted list is rewritten in place, so the purge survives the next
     remount/reload (not just this call's return value). */
  expect(JSON.parse(storage.getItem(draftsKey(PROJECT))!)).toEqual([agentA, agentB]);

  /* Every `llvWfDraft:*` field of both legacy drafts is gone — the removed
     WorkflowDraftPane can never repopulate itself from saved tab state. */
  for (const id of ["wf-alpha", "wf-beta"]) {
    for (const name of WF_FIELDS) expect(storage.getItem(wfField(id, name))).toBeNull();
  }
});

test("no restored draft can mount WorkflowDraftPane on either surface (#136)", () => {
  const restored = loadDrafts(PROJECT);
  /* Both the desktop scheme and the mobile focus view pick the pane by the same
     `isWorkflowDraftId(activeDraft.id)` gate. Render that exact branch over the
     restored ids: a workflow-draft id would emit the pane marker. None does. */
  const html = renderToStaticMarkup(
    <>
      {restored.map((id) =>
        isWorkflowDraftId(id) ? (
          <div key={id} data-testid="workflow-draft-pane" />
        ) : (
          <div key={id} data-testid="agent-draft-pane" />
        ),
      )}
    </>,
  );
  expect(html).not.toContain("workflow-draft-pane");
  expect((html.match(/agent-draft-pane/g) ?? []).length).toBe(2);
});

test("a clean list with no legacy drafts is returned untouched and rewrites nothing", () => {
  storage.setItem(draftsKey(PROJECT), JSON.stringify([agentA, agentB]));
  const restored = loadDrafts(PROJECT);
  expect(restored).toEqual([agentA, agentB]);
  /* No wf-* means no rewrite was needed; the stored list is byte-identical. */
  expect(storage.getItem(draftsKey(PROJECT))).toBe(JSON.stringify([agentA, agentB]));
});
