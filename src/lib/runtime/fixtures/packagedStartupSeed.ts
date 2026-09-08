import fs from "node:fs";
import path from "node:path";
import { AgentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { Database } from "bun:sqlite";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { RuntimeJournal } from "@/runtime-host/journal";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { captureProcessIdentity } from "@/lib/processIdentity";
function fixtureSessionId(index: number): string {
  return index < 6 ? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` : `history_${index}`;
}

function fixture(failedCount: number, fullHistory = false) {
  const mixed = process.env.LLV_PACKAGED_MIXED_ENGINES === "1";
  const directory = process.env.LLV_STATE_DIR!;
  const filename = path.join(directory, "agent-registry.json");
  if (!directory || fs.existsSync(filename)) throw new Error("packaged fixture requires an empty explicit state directory");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const begun = seed.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory, title: "Historical failed launch" }),
  });
  seed.failSpawn(begun.receipt.launchId, "historical failure");
  if (fullHistory) {
    const artifactPath = path.join(directory, "history-seed.jsonl");
    const conversation = seed.ensureConversation("codex", artifactPath, null);
    const sessionId = conversation.generations.at(-1)!.id;
    const delivery = seed.holdDelivery(conversation.id, "Historical delivery", "history-seed", "text");
    seed.recordDeliveryOutcome(delivery.id, "failed", "historical failure");
    seed.upsert({
      key: { engine: "codex", sessionId }, artifactPath, cwd: directory, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory }), status: "dead", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null,
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null,
        pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
  }
  const data = JSON.parse(fs.readFileSync(filename, "utf8")) as RegistryFile;
  const receipt = data.receipts[begun.receipt.launchId]!;
  data.receipts = {};
  for (let i = 0; i < failedCount; i++) {
    const launchId = `historical_launch_${i}`;
    data.receipts[launchId] = { ...receipt, launchId, conversationId: `conversation_history_${i}` };
  }
  if (fullHistory) {
    const entry = Object.values(data.entries)[0]!;
    const conversation = Object.values(data.conversations)[0]!;
    data.entries = {};
    data.conversations = {};
    for (let i = 0; i < 8078; i++) {
      const id = `conversation_history_${i}` as const;
      const sessionId = fixtureSessionId(i);
      const artifactPath = path.join(directory, `${sessionId}.jsonl`);
      if (i < 5188) data.entries[`codex:${sessionId}`] = {
        ...structuredClone(entry), key: { engine: "codex", sessionId }, artifactPath,
      };
      data.conversations[id] = {
        ...structuredClone(conversation), id,
        turn: { state: "terminal", source: "assistant", terminalAt: receipt.createdAt, observedAt: receipt.createdAt },
        generations: conversation.generations.map((generation) => ({ ...structuredClone(generation), id: sessionId, path: artifactPath })),
      };
    }
    const held = Object.values(data.heldDeliveries)[0]!;
    data.heldDeliveries = {};
    for (let i = 0; i < 1719; i++) {
      const id = `historical_delivery_${i}`;
      data.heldDeliveries[id] = {
        ...held, id, conversationId: `conversation_history_${i}`, clientMessageId: id,
        command: { ...held.command, operationId: `historical_operation_${i}` },
        state: i < 153 ? "failed" : "delivered",
      };
    }
    for (let i = failedCount; i < 6623; i++) {
      const launchId = `historical_launch_${i}`;
      data.receipts[launchId] = {
        ...receipt, launchId, conversationId: `conversation_history_${i}`,
        state: i < 6458 ? "completed" : i < 6590 ? "conflicted" : i < 6611 ? "starting"
          : i < 6618 ? "host-verified" : i < 6622 ? "pane-bound" : "path-pending",
      };
    }
  }
  for (const entry of Object.values(data.entries)) {
    // Real transcript refresh reads retained live rows; terminal tails prevent provider launches.
    entry.status = entry.key.sessionId === "history_0" ? "live" : "dead";
    fs.writeFileSync(entry.artifactPath, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_complete", last_agent_message: "Synthetic terminal history" } }) + "\n");
  }
  for (const receipt of Object.values(data.receipts)) {
    if (!["failed", "completed", "conflicted"].includes(receipt.state)) receipt.transport = null;
  }
  // Six real engine wrappers adopt local protocol-only provider children.
  for (let i = 0; i < 6; i++) {
    const id = fixtureSessionId(i);
    const row = data.entries[`codex:${id}`]!;
    row.pendingAction = "handoff";
    row.status = "live";
    data.conversations[`conversation_history_${i}`]!.turn = {
      state: "busy", source: "lifecycle", terminalAt: null, observedAt: receipt.createdAt,
    };
    fs.writeFileSync(row.artifactPath, JSON.stringify(!mixed || i < 3
      ? { type: "event_msg", timestamp: receipt.createdAt, payload: { type: "task_started", turn_id: `retained-${i}` } }
      : { type: "user", timestamp: receipt.createdAt, message: { role: "user", content: "Synthetic unfinished turn" } }) + "\n");
    if (mixed && i >= 3) {
      delete data.entries[`codex:${id}`];
      const nativePath = claudeTranscriptPath(directory, id, path.join(process.env.LLV_CLAUDE_HOME!, "projects"));
      fs.mkdirSync(path.dirname(nativePath), { recursive: true });
      fs.renameSync(row.artifactPath, nativePath);
      row.artifactPath = nativePath;
      data.conversations[`conversation_history_${i}`]!.generations[0]!.path = nativePath;
      row.key.engine = "claude";
      row.structuredHost!.kind = "claude-broker";
      data.entries[`claude:${id}`] = row;
      data.conversations[`conversation_history_${i}`]!.engine = "claude";
    }
    const launched = data.receipts[`historical_launch_${i}`]!;
    launched.state = "completed";
    launched.engine = row.key.engine;
    launched.key = { ...row.key };
    launched.artifactPath = row.artifactPath;
    data.receipts[`historical_launch_${failedCount + i}`]!.state = "failed";
  }
  data.identityMigrations["identity-wave-a-d-913"] = {
    completedAt: receipt.createdAt, retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0,
  };
  // Synthetic text only, approximating the live retained display-payload tail.
  for (const [i, row] of Object.values(data.receipts).entries()) {
    const size = i % 100 < 50 ? 0 : i % 100 < 95 ? 1800 : i % 100 < 99 ? 9200 : 62000;
    row.launchDisplay = size ? { prompt: "s".repeat(size), images: 0, echo: "Synthetic history" } : null;
    row.admissionOwner = null;
  }
  for (const [i, row] of Object.values(data.conversations).entries()) {
    row.generations[0]!.launchProfile.goal = {
      objective: "s".repeat(i % 100 < 50 ? 180 : i % 100 < 95 ? 900 : 2800),
      status: "complete", tokensUsed: null, timeUsedSeconds: null,
    };
  }
  const owner = Object.values(data.deliveryOperationOwners)[0]!;
  data.deliveryOperationOwners = {};
  for (let i = 0; i < 5649; i++) {
    const id = i < 1719 ? `historical_operation_${i}` : `historical_owner_${i}`;
    data.deliveryOperationOwners[id] = { ...owner, conversationId: `conversation_history_${i}`,
      runtimeConversationId: `conversation_history_${i}`,
      deliveryId: i < 1719 ? `historical_delivery_${i}` : id,
      clientMessageId: i < 1719 ? `historical_delivery_${i}` : id,
      terminalState: i < 153 ? "failed" : "delivered",
      command: { ...owner.command, operationId: id } };
  }
  for (let i = 1; i <= 5347; i++) {
    const id = `conversation_history_${i}` as const;
    data.lineageEdges[id] = {
      childConversationId: id, parentConversationId: "conversation_history_0",
      childSessionKey: { engine: mixed && i >= 3 && i < 6 ? "claude" : "codex", sessionId: fixtureSessionId(i) }, parentSessionKey: null,
      childArtifactPath: data.conversations[id]!.generations[0]!.path, parentArtifactPath: null,
      kind: "spawn", role: "worker", reviewsConversationId: null, source: "viewer-spawn",
      evidence: { launchId: `historical_launch_${i}`, clientAttemptId: null }, createdAt: receipt.createdAt,
    };
  }
  fs.writeFileSync(filename, JSON.stringify(data));
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const pendingProfile = emptyLaunchProfile({ cwd: directory, title: "Deferred startup launch" });
  const pending = registry.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: "account-a",
    accountPin: true, clientAttemptId: "original-deferred-startup-key", launchProfile: pendingProfile,
  });
  registry.queuePinnedSpawn(pending.receipt.launchId, {
    version: 1, retryAt: new Date(Date.now() + 3_600_000).toISOString(), accountId: "account-a", locale: "en",
    spec: { engine: "codex", command: "codex", cwd: directory, windowName: "deferred-startup", launchProfile: pendingProfile },
    ["prompt"]: "Synthetic deferred work", imageRefs: [], parentArtifactPath: null, pipelineSourceConversationId: null,
  }, "Synthetic account retry window");
  registry.releaseStartingStructuredSpawn(pending.receipt.launchId, pending.receipt.admissionOwner!);
  fs.writeFileSync(path.join(directory, "pending-spawn-before.json"), JSON.stringify({
    [pending.receipt.launchId]: registry.readOnlySnapshot().receipts[pending.receipt.launchId],
  }));
  const externalKeys: string[] = [];
  for (const [index, pid] of (JSON.parse(process.env.LLV_PACKAGED_EXTERNAL_PIDS ?? "[]") as number[]).entries()) {
    const engine = index === 0 ? "codex" : "claude";
    const artifactPath = path.join(directory, `external-${engine}.jsonl`);
    fs.writeFileSync(artifactPath, "");
    const conversation = registry.ensureConversation(engine, artifactPath, null);
    const key = { engine, sessionId: conversation.generations.at(-1)!.id } as const;
    registry.upsert({ ...structuredClone(Object.values(data.entries)[0]!), key, artifactPath,
      status: "idle", pendingAction: null, claimOwner: null, claimEpoch: 0,
      launchProfile: emptyLaunchProfile({ cwd: directory, mcpServers: [] }),
      structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker",
        endpoint: "external:independent", process: null, eventCursor: 0, protocolVersion: "fixture",
        writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    });
    const owner = captureProcessIdentity(pid);
    const claimed = registry.claimStructuredHost(key, owner)!;
    registry.setStructuredHostClaimed(key, { ...claimed.structuredHost!, process: owner }, "idle", claimed.claimOwner!, claimed.claimEpoch);
    externalKeys.push(`${engine}:${key.sessionId}`);
  }
  fs.writeFileSync(path.join(directory, "external-before.json"), JSON.stringify(Object.fromEntries(
    externalKeys.map((key) => [key, registry.readOnlySnapshot().entries[key]]),
  )));
  fs.writeFileSync(path.join(directory, "rehearsal-budgets.json"), JSON.stringify({
    // Bound this rehearsal observation, not production serving readiness.
    serving: 300_000, action: 360_000,
  }));
  console.log(JSON.stringify({ counts: Object.fromEntries((["conversations", "entries", "receipts", "heldDeliveries"] as const).map(k => [k, Object.keys(data[k]).length])) }));
  registry.checkpointRollbackMirrorForDemotion();
  const journalFilename = path.join(directory, "runtime-events.sqlite");
  const journal = new RuntimeJournal(journalFilename, { structuredHosts: true });
  for (let i = 0; i < 4336; i++) {
    const entry = data.entries[`${mixed && i >= 3 && i < 6 ? "claude" : "codex"}:${fixtureSessionId(i)}`]!;
    journal.append({ scope: { type: "session", id: `conversation_history_${i}` }, kind: "session-status",
      payload: { conversationId: `conversation_history_${i}`, sessionKey: entry.key,
        hostKind: entry.structuredHost!.kind, host: i < 734 ? "hosted" : "dead", turn: "idle", cwd: directory,
        artifactPath: entry.artifactPath, accountId: null, activeTurnId: null },
    });
  }
  for (let i = 0; i < 6; i++) journal.executeOperation({
    kind: "send", conversationId: `conversation_history_${i}`, idempotencyKey: `queued-startup-${i}`,
    text: `Synthetic queued startup message queued-startup-${i}`, policy: "queue",
  });
  journal.close();
  // Retained legacy rows precede live-turn bounding. Recreate sizes with fresh
  // synthetic text, using the same fixture seam as journal.test.ts.
  const raw = new Database(journalFilename);
  raw.transaction(() => {
    const update = raw.query("UPDATE entities SET state_json = json_set(state_json, '$.liveTurn', json(?)) WHERE kind = 'session' AND id = ?");
    for (let i = 0; i < 4336; i++) {
      const size = i % 100 < 50 ? 23000 : i % 100 < 95 ? 30000 : i % 100 < 99 ? 99000 : 517000;
      update.run(JSON.stringify({ turnId: "historical-turn", text: "s".repeat(size) }), `conversation_history_${i}`);
    }
  })();
  raw.close();
}
fixture(672, true);
