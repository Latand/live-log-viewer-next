import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { agentLivenessSnapshot, productionLivenessSources } from "@/lib/lifecycle/liveness";
import { contextWindowPolicyFor } from "@/lib/orchestrator/contextPolicy";
import {
  contextReading,
  readOrchestratorTranscriptFacts,
  rotationRecommendation,
  type OrchestratorContextReading,
  type RotationRecommendation,
} from "@/lib/orchestrator/health";
import { canonicalOrchestratorProject, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { readSession } from "@/lib/session/reader";

/**
 * WHO currently holds the seat, and how worn they are (PRD #976 slice B).
 *
 * The recommendation to rotate has existed since the two-axis contract, but only
 * inside `get_orchestrator` — an operator watching the panel could not see the
 * incumbent's model, its context pressure, or the fact that the server had been
 * recommending a rotation for hours. This is that same reading over HTTP, so the
 * panel never has to speak MCP from the browser.
 *
 * It is composed from exactly the pieces `get_orchestrator` composes it from
 * (`@/lib/orchestrator/health` + `@/lib/orchestrator/contextPolicy`), called with
 * the same inputs, so the panel and the MCP tool cannot drift into two different
 * opinions about the same seat.
 *
 * WORDS ONLY, structurally: every export here is a READ. Nothing on this path
 * spawns, designates, revokes or rotates anything — crossing the rotation
 * threshold changes what this payload SAYS and nothing else. Rotation happens
 * only when the operator explicitly posts `/api/orchestrator/rotate`.
 */

export interface OrchestratorIncumbentLiveness {
  lifecycle: string;
  hostState: string;
  silentForMs: number | null;
}

export interface OrchestratorIncumbentBody {
  project: string;
  /** False means no active seat: the panel is on its draft, and every field
      below is null rather than a stale memory of the last incumbent. */
  designated: boolean;
  conversationId: string | null;
  seatEpoch: number | null;
  /** The predecessor this incumbent replaced, for the board link back. */
  predecessorConversationId: string | null;
  engine: "claude" | "codex" | null;
  model: string | null;
  effort: string | null;
  accountId: string | null;
  cwd: string | null;
  promptVersion: number | null;
  transcriptPath: string | null;
  liveness: OrchestratorIncumbentLiveness | null;
  transcriptFacts: {
    bytes: number | null;
    messageCount: number | null;
    toolCount: number | null;
    compactionCount: number | null;
  } | null;
  context: OrchestratorContextReading | null;
  rotation: (RotationRecommendation & { note: string }) | null;
}

/** Same sentence `get_orchestrator` carries, for the same reason: a reader of
    this payload must never be able to mistake it for an instruction. */
export const ROTATION_NOTE = "recommendation only — rotation never happens automatically; call rotate_orchestrator explicitly";

export interface IncumbentReadDependencies {
  conversation: (id: ViewerConversationId) => RegistryConversation | null;
  /** The liveness plane's answer for one conversation, or null when it has
      none. Throwing is answered as «unknown», never as «dead». */
  liveness: (id: ViewerConversationId) => Promise<OrchestratorIncumbentLiveness | null>;
  /** Message/tool/compaction counts, the one expensive read. Injected so a test
      — and a future cheaper reader — can supply them without a transcript. */
  sessionCounts: (path: string, engine: "claude" | "codex") => { messages: number; tools: number; compactions: number } | null;
}

export const productionIncumbentDependencies: IncumbentReadDependencies = {
  conversation: (id) => agentRegistry().conversation(id),
  liveness: async (id) => {
    /* Targeted by conversation id, exactly as `get_orchestrator` asks it: the
       targeted branch resolves ONE transcript and never sweeps the catalog. */
    const snapshot = await agentLivenessSnapshot({ conversationId: id, limit: 1 }, productionLivenessSources());
    const record = snapshot.conversations[0];
    return record ? { lifecycle: record.lifecycle, hostState: record.host.state, silentForMs: record.silentForMs } : null;
  },
  sessionCounts: (path, engine) => {
    try {
      const read = readSession(path, engine);
      return {
        messages: read.messages.length,
        tools: read.tools.length,
        compactions: read.traces.filter((trace) => trace.name === "compact").length,
      };
    } catch {
      /* An unreadable transcript reports absent counts; it never guesses. */
      return null;
    }
  },
};

const VACANT = (project: string): OrchestratorIncumbentBody => ({
  project,
  designated: false,
  conversationId: null,
  seatEpoch: null,
  predecessorConversationId: null,
  engine: null,
  model: null,
  effort: null,
  accountId: null,
  cwd: null,
  promptVersion: null,
  transcriptPath: null,
  liveness: null,
  transcriptFacts: null,
  context: null,
  rotation: null,
});

/**
 * The active seat's incumbent, or a vacant reading.
 *
 * Engine and model resolve from the REGISTRY alone, which since #981 is the
 * only place they live. A generation the registry has not settled yet reads
 * here as «unknown» — which the panel renders as «resolving» rather than
 * inventing a model to judge context pressure by.
 */
export async function readOrchestratorIncumbent(
  rawProject: string,
  dependencies: IncumbentReadDependencies = productionIncumbentDependencies,
): Promise<OrchestratorIncumbentBody> {
  const project = canonicalOrchestratorProject(rawProject);
  const active = orchestratorSeatFor(project).active;
  if (!active?.conversationId) return VACANT(project);

  const conversation = dependencies.conversation(active.conversationId as ViewerConversationId);
  const generation = conversation?.generations.at(-1);
  const transcriptPath = generation?.path ?? active.path;
  const engine = conversation?.engine ?? null;
  const model = generation?.launchProfile?.model ?? null;
  const counts = transcriptPath && engine ? dependencies.sessionCounts(transcriptPath, engine) : null;
  const facts = readOrchestratorTranscriptFacts(transcriptPath, counts);
  const policy = contextWindowPolicyFor(engine, model);
  const context = contextReading({ policy, facts });

  let liveness: OrchestratorIncumbentLiveness | null = null;
  try {
    liveness = await dependencies.liveness(active.conversationId as ViewerConversationId);
  } catch {
    /* A liveness read that cannot answer says nothing; it never claims «dead»,
       which would be a rotation reason invented out of an error. */
    liveness = null;
  }

  return {
    project,
    designated: true,
    conversationId: active.conversationId,
    seatEpoch: active.seatEpoch,
    predecessorConversationId: active.predecessorConversationId,
    engine,
    model,
    effort: generation?.launchProfile?.effort ?? null,
    accountId: generation?.accountId ?? null,
    cwd: generation?.launchProfile?.cwd || null,
    promptVersion: active.promptVersion,
    transcriptPath,
    liveness,
    transcriptFacts: {
      bytes: facts.transcriptBytes,
      messageCount: facts.messageCount,
      toolCount: facts.toolCount,
      compactionCount: facts.compactionCount,
    },
    context,
    rotation: {
      ...rotationRecommendation({
        context,
        facts,
        activity: liveness?.lifecycle === "gone" ? "dead" : liveness?.lifecycle ?? null,
        policy,
      }),
      note: ROTATION_NOTE,
    },
  };
}
