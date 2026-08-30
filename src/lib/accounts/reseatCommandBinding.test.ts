import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { AgentRegistry, type ConversationObservation } from "@/lib/agent/registry";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";

/**
 * #1279 at the AUTOMATIC seam. A one-click reseat names no account: the Viewer
 * picks the successor itself, which is exactly the selection a project's pool
 * binds. So this path — unlike a switch that names an account — refuses rather
 * than reaching outside the pool, and refuses when the record that defines the
 * pool cannot be read: a machine that cannot see the boundary does not get to
 * decide it is not there.
 *
 * Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reseat-command-binding-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = STATE;

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(STATE, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function observation(pathname: string, accountId: string): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo/checkout", title: "Implementer", project: "project-atlas", role: "worker" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: new Date().toISOString(),
  };
}

function seeded(name: string): { registry: AgentRegistry; id: ViewerConversationId } {
  const registry = new AgentRegistry(path.join(SANDBOX, `${name}.json`), undefined, undefined, { sqliteMode: "off" });
  registry.reconcileConversations([observation("/sessions/limited.jsonl", "acct-reserved")]);
  return { registry, id: registry.conversationForPath("/sessions/limited.jsonl")!.id };
}

test("a binding record that cannot be read parks the reseat instead of picking freely", async () => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");
  const { registry, id } = seeded("damaged");

  const result = await applyConversationMigration({ conversationId: id, action: "reseat" }, { registry: () => registry });

  /* The contract's own refusal, naming the record to repair — not an unhandled
     failure escaping as a server fault. */
  expect(result.status).toBe(409);
  expect(String((result.body as { error: string }).error)).toContain("account-project-bindings.json");
  expect(String((result.body as { error: string }).error)).toContain("repaired or removed");
  /* And nothing was queued: the conversation is where it was. */
  expect(registry.conversation(id)?.migration ?? null).toBeNull();
});

test("an unbound project reseats exactly as it always did", async () => {
  const { registry, id } = seeded("unbound");
  expect(fs.existsSync(RECORD)).toBe(false);

  const result = await applyConversationMigration({ conversationId: id, action: "reseat" }, { registry: () => registry });

  /* No account in this fixture has fresh quota headroom, so the answer is the
     shortage this path has always reported — reached, rather than refused on
     the record before it. */
  expect(result.status).toBe(409);
  expect((result.body as { error: string }).error).toBe("no healthy account with fresh quota headroom is available");
  expect(registry.conversation(id)?.migration ?? null).toBeNull();
});
