import { bridgeDirectiveId } from "./directive";
import { acceptDirectDeployIntent, type AcceptedDeployIntent } from "./deployIntent";

/**
 * #795 bootstrap — closing the chicken-and-egg the review named out loud.
 *
 * The direct-intent acceptance path lives in `bridge_directive`, which
 * production only serves AFTER the new Viewer is deployed — and deploying the
 * new Viewer is the very thing awaiting authorization. Meanwhile the operator
 * HAS already stated the deploy: their directive sits, delivered, in the voice
 * root's own transcript. Production admission understands exactly one thing —
 * a `confirmation_request` row's ref + nonce.
 *
 * This module is the one-time conversion between those two facts. Run from the
 * merged exact-head TREE (a checkout; the serving Viewer stays old), it:
 *
 *   1. takes a directive DELIVERY ID, never prose — the id must derive from a
 *      `bridge_directive` call recorded in the ROOT session's transcript, so
 *      the thing being converted is an utterance the gateway actually relayed,
 *      attributed by the same identity chain production trusts;
 *   2. refuses a directive older than the bounded bootstrap window, or one
 *      with no designated seat to bind to;
 *   3. pins current remote main and records the existing-format single-use
 *      authorization (`recordDirectDeployIntent` — flagged so the gateway
 *      never drains it back at the operator);
 *   4. optionally invokes the ALREADY-DEPLOYED exact-SHA executor once,
 *      health-gated, with the minted ref + nonce.
 *
 * No operator prompt, no hash phrase, no gateway drainage — the operator's
 * one recorded sentence is the entire authorization, same as the live path.
 */

/** A directive older than this cannot bootstrap a deploy: a stale "deploy"
    resurfacing days later is exactly the drift the expiry model refuses. */
export const DEPLOY_INTENT_BOOTSTRAP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

interface TranscriptToolCall {
  name?: string;
  text: string;
  ts: string | null;
}

export interface DeployIntentBootstrapSources {
  /** The live voice-root session, resolved from the durable registry/lineage —
      never from anything the invoker types. Null refuses. */
  root(): { conversationId: string; transcriptPath: string; engine: "claude" | "codex" } | null;
  /** Tool-call records of one transcript, oldest first. */
  toolCalls(transcriptPath: string, engine: "claude" | "codex"): TranscriptToolCall[];
  /** Validated designated seats, same authority the live routing uses. */
  seats(): { project: string; conversationId: string }[];
  /** The root session's canonical project, for an unscoped directive. */
  rootProject(): string | null;
  resolveRemoteMain(): Promise<string>;
  now?(): Date;
}

export class DeployIntentBootstrapRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeployIntentBootstrapRefusal";
    this.code = code;
  }
}

export interface BootstrappedDeployIntent extends AcceptedDeployIntent {
  project: string;
  /** The recorded operator words the authorization derives from. */
  instruction: string;
}

function directiveArgs(record: TranscriptToolCall): Record<string, unknown> | null {
  const name = record.name ?? "";
  if (name !== "bridge_directive" && !name.endsWith("__bridge_directive")) return null;
  try {
    const parsed = JSON.parse(record.text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Convert one already-delivered root directive into the existing-format
 * single-use authorization. Pure over its sources; the CLI wires production.
 */
export async function bootstrapDirectDeployIntent(
  deliveryId: string,
  sources: DeployIntentBootstrapSources,
): Promise<BootstrappedDeployIntent> {
  const now = sources.now?.() ?? new Date();
  if (!/^bridge_d_[A-Za-z0-9_.:-]+_\d+$/.test(deliveryId)) {
    throw new DeployIntentBootstrapRefusal("delivery_id_malformed", "the argument must be a bridge directive delivery id (bridge_d_<turn>_<utterance>)");
  }

  const root = sources.root();
  if (!root) {
    throw new DeployIntentBootstrapRefusal("no_root_session", "no live voice-root session is registered; the bootstrap only converts a directive the gateway relayed");
  }

  /* The directive must exist in the ROOT transcript under exactly this derived
     id. Prose typed at this command authorizes nothing — only the durable
     record of what the gateway relayed does. */
  let found: { args: Record<string, unknown>; ts: string | null } | null = null;
  for (const record of sources.toolCalls(root.transcriptPath, root.engine)) {
    const args = directiveArgs(record);
    if (!args) continue;
    const rootTurnId = typeof args.rootTurnId === "string" ? args.rootTurnId : "";
    const utterance = typeof args.utterance === "number" ? args.utterance : NaN;
    if (!rootTurnId || !Number.isInteger(utterance) || utterance < 0) continue;
    try {
      if (bridgeDirectiveId(rootTurnId, utterance) === deliveryId) found = { args, ts: record.ts };
    } catch {
      continue;
    }
  }
  if (!found) {
    throw new DeployIntentBootstrapRefusal("directive_not_attributed", "no bridge_directive with this delivery id exists in the root session's transcript; the bootstrap refuses anything the gateway did not relay");
  }

  const recordedAt = found.ts ? Date.parse(found.ts) : NaN;
  if (!Number.isFinite(recordedAt) || now.getTime() - recordedAt > DEPLOY_INTENT_BOOTSTRAP_MAX_AGE_MS) {
    throw new DeployIntentBootstrapRefusal("directive_stale", "the recorded directive is older than the bootstrap window (or carries no timestamp); the operator must state the deploy again");
  }

  const instruction = typeof found.args.instruction === "string" ? found.args.instruction.trim() : "";

  const project = (typeof found.args.project === "string" && found.args.project.trim())
    || sources.rootProject();
  if (!project) {
    throw new DeployIntentBootstrapRefusal("project_unresolved", "the directive names no project and the root session resolves to none");
  }
  const seat = sources.seats().find((candidate) => candidate.project === project);
  if (!seat) {
    throw new DeployIntentBootstrapRefusal("manager_not_designated", "no validated orchestrator seat exists for the directive's project");
  }

  const accepted = await acceptDirectDeployIntent({
    directiveId: deliveryId,
    project,
    seatConversationId: seat.conversationId,
    origin: { kind: "gateway", conversationId: root.conversationId, role: null },
    instruction,
    resolveRemoteMain: sources.resolveRemoteMain,
    now,
  });
  return { ...accepted, project, instruction };
}
