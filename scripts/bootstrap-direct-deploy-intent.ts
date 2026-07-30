/**
 * #795 one-time bootstrap: convert the operator's ALREADY-DELIVERED deploy
 * directive into the existing-format single-use deploy authorization, and
 * (optionally) invoke the already-deployed exact-SHA executor once.
 *
 *   bun scripts/bootstrap-direct-deploy-intent.ts <deliveryId> [--execute]
 *
 * Run from the merged exact-head TREE while production still serves the old
 * Viewer. `<deliveryId>` is the directive's delivery id
 * (`bridge_d_<turn>_<utterance>`); it must name a `bridge_directive` call
 * recorded in the voice root's own transcript — prose typed here authorizes
 * nothing. Minting is idempotent under the id, so a re-run replays the same
 * authorization instead of stacking a second one.
 *
 * `--execute` additionally posts the deployment to the SERVING Viewer's
 * existing route with the minted ref + nonce, health-gated on the route
 * actually answering first. Without it, only the authorization is recorded.
 *
 * Output stays public-safe: sequence numbers, a shortened revision, expiry.
 */
import { agentRegistry } from "@/lib/agent/registry";
import {
  bootstrapDirectDeployIntent,
  DeployIntentBootstrapRefusal,
  type DeployIntentBootstrapSources,
} from "@/lib/bridge/deployIntentBootstrap";
import { resolveRemoteMainRevision } from "@/lib/bridge/deployIntent";
import { authorizedManagerSeats, type ManagerAuthoritySources } from "@/lib/orchestrator/authority";
import { activeOrchestratorSeats, orchestratorRevocations } from "@/lib/orchestrator/seats";
import { readOrchestratorRecord } from "@/lib/orchestrator/store";
import { liveRootSession } from "@/lib/root/adopt";
import { projectForCwd } from "@/lib/scanner/describe";
import { readSession } from "@/lib/session/reader";

function managerAuthoritySources(): ManagerAuthoritySources {
  const registry = agentRegistry();
  return {
    activeSeats: activeOrchestratorSeats,
    revocations: orchestratorRevocations,
    legacyManagerConversationId: () => readOrchestratorRecord()?.conversationId ?? null,
    conversationFacts: (conversationId) => {
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return null;
      return {
        superseded: conversation.supersededBy !== null,
        hasGeneration: conversation.generations.length > 0,
        project: conversation.projectOwnership?.project ?? null,
      };
    },
    resolveAlias: (conversationId) =>
      registry.conversation(conversationId as `conversation_${string}`)?.id ?? conversationId,
  };
}

function productionSources(): DeployIntentBootstrapSources {
  const registry = agentRegistry();
  return {
    root: () => {
      const snapshot = registry.readOnlySnapshot();
      const candidate = liveRootSession({
        conversations: Object.values(snapshot.conversations),
        configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
      });
      if (!candidate) return null;
      const conversation = registry.conversation(candidate.conversationId as `conversation_${string}`);
      const generation = conversation?.generations.at(-1);
      const engine = conversation?.engine;
      const transcriptPath = generation?.path ?? candidate.path;
      if (!transcriptPath || (engine !== "claude" && engine !== "codex")) return null;
      return { conversationId: candidate.conversationId, transcriptPath, engine };
    },
    toolCalls: (transcriptPath, engine) =>
      readSession(transcriptPath, engine).tools.filter((record) => record.kind === "tool_call"),
    seats: () => authorizedManagerSeats(managerAuthoritySources())
      .flatMap((seat) => (seat.project ? [{ project: seat.project, conversationId: seat.conversationId }] : [])),
    rootProject: () => {
      const snapshot = registry.readOnlySnapshot();
      const candidate = liveRootSession({
        conversations: Object.values(snapshot.conversations),
        configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
      });
      if (!candidate) return null;
      const conversation = registry.conversation(candidate.conversationId as `conversation_${string}`);
      if (conversation?.projectOwnership?.project) return conversation.projectOwnership.project;
      const cwd = conversation?.generations.at(-1)?.launchProfile?.cwd?.trim();
      return cwd ? projectForCwd(cwd) : null;
    },
    resolveRemoteMain: resolveRemoteMainRevision,
  };
}

async function executeOnce(deliveryId: string, intent: { ref: number; nonce: string; sha: string }): Promise<void> {
  const base = process.env.LLV_VIEWER_CONTROL_URL?.trim() || "http://127.0.0.1:8898";
  /* Health gate: the SERVING (old) Viewer must actually answer the deployments
     route before the single-use proof is presented anywhere. */
  const health = await fetch(new URL("/api/runtime/deployments?limit=1", base), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!health || !health.ok) {
    throw new Error("the serving Viewer's deployments route is not healthy; nothing was presented (the minted authorization stays valid until expiry)");
  }
  const response = await fetch(new URL("/api/runtime/deployments", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      revision: intent.sha,
      idempotencyKey: `bootstrap_${deliveryId}`,
      bridgeRef: intent.ref,
      bridgeNonce: intent.nonce,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok && body.state !== "busy") {
    throw new Error(`deployment request refused (${response.status}): ${typeof body.error === "string" ? body.error : "no detail"}`);
  }
  console.log(`deployment ${String(body.deploymentId ?? "?")} ${String(body.state ?? "accepted")} for ${intent.sha.slice(0, 12)}`);
}

async function main(): Promise<void> {
  const [deliveryId, flag] = process.argv.slice(2);
  if (!deliveryId) {
    console.error("usage: bun scripts/bootstrap-direct-deploy-intent.ts <deliveryId> [--execute]");
    process.exit(2);
  }
  try {
    const intent = await bootstrapDirectDeployIntent(deliveryId, productionSources());
    console.log([
      intent.replayed
        ? `replayed existing authorization ref=${intent.ref}`
        : `recorded authorization ref=${intent.ref}`,
      `revision=${intent.sha.slice(0, 12)} (pinned from remote main)`,
      `expires=${intent.expiresAt}`,
      intent.supersededSeqs.length > 0 ? `superseded=${intent.supersededSeqs.join(",")}` : null,
    ].filter(Boolean).join("\n"));
    if (flag === "--execute") await executeOnce(deliveryId, intent);
  } catch (error) {
    if (error instanceof DeployIntentBootstrapRefusal) {
      console.error(`refused (${error.code}): ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

await main();
