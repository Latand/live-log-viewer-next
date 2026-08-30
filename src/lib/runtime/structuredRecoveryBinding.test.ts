import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";

import type { RuntimeHostClient } from "./client";
import { recoverDeadStructuredConversation } from "./structuredRecovery";

/**
 * #1279 at the RESUME seam.
 *
 * Recovery resolved its account through `resolveSpawn`, whose second argument
 * is nullable — and a conversation that records no account (an adopted thread,
 * the majority of live ones) turned that null into the engine's routing
 * account, silently, without the project's pool or any quota being consulted.
 * The rule now lives behind one shared decision, which `managerProjectBinding`
 * proves; what this file proves is the half that decision cannot see for
 * itself: the project reaches it, and the account the conversation already
 * records reaches it unchanged.
 *
 * Account and project names are invented.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-recovery-binding-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const ATLAS = "project-atlas";

/** A conversation with a dead host, ready for recovery to reseat. */
function deadHostedConversation(recordedAccountId: string | null) {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `resume-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation("codex", artifactPath, recordedAccountId);
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: recordedAccountId,
    /* The durable entry names the project, which is what an adopted
       conversation has instead of a launch profile of its own. */
    launchProfile: emptyLaunchProfile({ cwd, project: ATLAS }),
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  return { registry, conversation, artifactPath, cwd };
}

async function resumeAsking(recordedAccountId: string | null): Promise<Array<[string, string | null, string | null]>> {
  const state = deadHostedConversation(recordedAccountId);
  const asked: Array<[string, string | null, string | null]> = [];
  await recoverDeadStructuredConversation({
    path: state.artifactPath,
    conversationId: state.conversation.id,
  }, {
    registry: state.registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: (engine, accountId, project) => {
      asked.push([engine, accountId, project]);
      return {
        engine,
        accountId: accountId ?? "picked-carrier",
        kind: "managed",
        home: state.cwd,
        transcriptRoot: state.cwd,
        env: { NODE_ENV: "test" },
      } as AccountContext;
    },
    spawn: async (input) => ({
      ok: true,
      target: null,
      path: state.artifactPath,
      launchId: input.receipt.launchId,
      conversationId: state.conversation.id,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    }),
  });
  return asked;
}

test("a resume that has to choose an account asks with the project its work belongs to (#1279)", async () => {
  /* The conversation records no account, so resuming it is a PICK. The pick
     cannot be fenced by a pool nobody named, so the project travels with it. */
  expect(await resumeAsking(null)).toEqual([["codex", null, ATLAS]]);
});

test("a resume of work that records an account carries that account, unchanged (#1279)", async () => {
  /* Continuity, not a selection: the session lives in that account's home.
     The project rides along so one decision answers both halves, and the
     recorded account is what it is handed. */
  expect(await resumeAsking("retained-carrier")).toEqual([["codex", "retained-carrier", ATLAS]]);
});
