import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { after, NextRequest, NextResponse } from "next/server";

import { UnknownAccountError } from "@/lib/accounts/codex";
import { claudeSettingsPath, isManagedClaudeHome, UnknownClaudeAccountError } from "@/lib/accounts/claude";
import type { AccountContext } from "@/lib/accounts/contracts";
import { accountManager, resolveHealthySpawnAccount, type HealthySpawnAccountResolution } from "@/lib/accounts/manager";
import { emptyLaunchProfile, validExplicitProject } from "@/lib/accounts/migration/contracts";
import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { agentRegistry, SpawnChildLimitError, type SpawnRequest } from "@/lib/agent/registry";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { grantedMcpServers, mcpServersForSession, normalizeSpawnMcpServers, SCHEDULED_REPORT_SESSION_CLASS, type McpSessionClass } from "@/lib/agent/mcpAllowlist";
import { normalizeSpawnPlugins, pluginAllowlistForSession, SCHEDULED_REPORT_PLUGINS, sessionOriginFor } from "@/lib/agent/pluginAllowlist";
import { codexModelSupportsImages, modelFromBody, validateLaunchModel } from "@/lib/agent/models";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { assertDarwinStructuredRuntime } from "@/lib/proc/darwinIdentity";
import { spawnContentDigest, spawnParentSelector, spawnRequestDigest } from "@/lib/agent/spawnIdentity";
import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { resolveSpawnLineage, SpawnParentError } from "@/lib/agent/spawnParent";
import { SpawnAdmissionError, isSpawnDeniedRole } from "@/lib/agent/spawnAdmission";
import { spawnRejectionResponse, spawnReplayStatus, spawnResponseForReceipt, type SpawnResponse } from "@/lib/agent/spawnResponse";
import { applyClaudeSpawnPolicy, prepareManagedClaudeSpawnHome } from "@/lib/agent/spawnPolicy";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { runtimeHostClient, RuntimeHostUnavailableError } from "@/lib/runtime/client";
import { runtimeScope } from "@/lib/runtime/contracts";
import { publishFilesRevision } from "@/lib/runtime/filesRevision";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { runtimeImageCapability, runtimeImageStore, type RuntimeImageUpload } from "@/lib/runtime/runtimeImageStore";
import { assertStructuredTextEnvelope, type StructuredImageRef } from "@/lib/runtime/structuredContent";
import { queuedPinnedSpawnTitle, reconcileStructuredSpawnReplay, resolvePinnedSpawnAdmission, spawnStructuredConversation, structuredClaudePermissionMode } from "@/lib/runtime/structuredSpawn";
import { structuredSpawnGap, spawnTransport } from "@/lib/runtime/spawnTransport";
import { adoptPipelineAttemptFromSource, pipelineAttemptTargetForSource } from "@/lib/pipelines/engine";
import { listFiles } from "@/lib/scanner";
import { projectForCwd } from "@/lib/scanner/describe";
import { projectDirectoryCandidates } from "@/lib/scanner/projectDirectories";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { buildImagePayload, collectImagePayloads, deleteInboxImages, spawnAgentWithPrompt, verifyTmuxHostEvidence } from "@/lib/tmux";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import type { ApiError } from "@/lib/types";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";

import { sourceCwdStatus } from "@/app/api/spawn/sourceCwd";
import { AGENT_SPAWN_LINEAGE_ERROR, agentSpawnLineageError, authenticatedAgentSpawnCaller, isAgentInitiatedSpawn, spawnLineageSelectorForCaller, type AuthenticatedSpawnCaller } from "@/app/api/spawn/admission";
import { spawnAccountErrorResponse } from "@/app/api/spawn/accountError";

const SUGGEST_SCAN_LIMIT = 80;
const SUGGEST_MAX = 10;
const PIN_FALLBACK_TITLE_EN = en["spawnCard.pinUnavailableFallback"];
const PIN_FALLBACK_TITLE_UK_MESSAGE = uk["spawnCard.pinUnavailableFallback"];
const PIN_FALLBACK_TITLE_UK = typeof PIN_FALLBACK_TITLE_UK_MESSAGE === "string"
  ? PIN_FALLBACK_TITLE_UK_MESSAGE
  : PIN_FALLBACK_TITLE_EN;

function prefersUkrainian(req: Pick<NextRequest, "headers">): boolean {
  const language = req.headers.get("accept-language")?.trim().toLowerCase() ?? "";
  return language === "uk" || language.startsWith("uk-");
}

function pinFallbackTitle(req: Pick<NextRequest, "headers">): string {
  return prefersUkrainian(req)
    ? PIN_FALLBACK_TITLE_UK
    : PIN_FALLBACK_TITLE_EN;
}

export interface SpawnCommandDependencies {
  registry: typeof agentRegistry;
  resolveHealthySpawnAccount: typeof resolveHealthySpawnAccount;
  resolveSpawnAccount: typeof accountManager.resolveSpawn;
  resolvePinnedSpawnAdmission?: typeof resolvePinnedSpawnAdmission;
  runtimeHostClient: typeof runtimeHostClient;
  publishFilesRevision?: typeof publishFilesRevision;
  spawnStructuredConversation: typeof spawnStructuredConversation;
  assertStructuredRuntime: typeof assertDarwinStructuredRuntime;
  defer(work: () => Promise<void>): void;
  storeImages(images: readonly RuntimeImageUpload[]): StructuredImageRef[];
  spawnTmuxAgent?: typeof spawnAgentWithPrompt;
  adoptPipelineAttemptFromSource?: typeof adoptPipelineAttemptFromSource;
  pipelineAttemptTargetForSource?: typeof pipelineAttemptTargetForSource;
  /**
   * A grant the VIEWER itself elects for a launch it makes on its own timer
   * (issue #1086), rather than one derived from the request's session origin.
   *
   * It is a callback so it resolves here, at admission, from durable state at
   * the instant the grant is decided. Only an in-process caller can supply
   * one: `/api/spawn` calls {@link executeSpawnRequest} with no dependencies,
   * so no request body, header or query reaches this seam. `sessionClass` is
   * checked against the classes admission accepts internally, so a future
   * caller cannot invent one, and the servers are re-bounded by the global
   * grantable set before use — the seam can only narrow.
   *
   * The class decides the launch's WHOLE capability surface: the MCP list, the
   * plugin grant, and the durable display copy of the prompt all follow from
   * it, so a class that states an exact surface cannot then inherit a wider one
   * through the origin classifier.
   */
  internalGrant?(): { sessionClass: McpSessionClass; mcpServers: readonly string[] } | null;
  recordOperatorActivity?: typeof recordDirectOperatorWakatimeActivity;
}

class RuntimeImageStorageError extends Error {}

export const productionSpawnCommandDependencies: SpawnCommandDependencies = {
  registry: agentRegistry,
  resolveHealthySpawnAccount,
  resolveSpawnAccount: (engine, accountId) => accountManager.resolveSpawn(engine, accountId),
  resolvePinnedSpawnAdmission,
  runtimeHostClient,
  publishFilesRevision,
  spawnStructuredConversation,
  assertStructuredRuntime: assertDarwinStructuredRuntime,
  defer: (work) => after(work),
  storeImages: (images) => runtimeImageStore().putMany(images),
  adoptPipelineAttemptFromSource,
  pipelineAttemptTargetForSource,
  recordOperatorActivity: recordDirectOperatorWakatimeActivity,
};

interface SuggestResponse {
  dirs: string[];
  /** Working directory of the `src` transcript when one was requested. */
  cwd: string | null;
  /** Whether the recorded source directory currently exists. */
  cwdExists: boolean;
  spawnTransport: "tmux" | "structured";
  imageInput: {
    claude: ReturnType<typeof runtimeImageCapability>;
    codex: ReturnType<typeof runtimeImageCapability>;
  };
}

function addDir(dirs: string[], cwd: string | null, project: string): void {
  if (!cwd || dirs.includes(cwd)) return;
  if (project && projectForCwd(cwd) !== project) return;
  dirs.push(cwd);
}

/** Recent real working directories to prefill the spawn dialog; the current
    project's transcripts rank first so its directory lands on top. `src` names
    a transcript whose own cwd must win — the handoff card inherits it. */
export async function spawnSuggestions(req: NextRequest): Promise<NextResponse<SuggestResponse>> {
  const project = req.nextUrl.searchParams.get("project") ?? "";
  const src = req.nextUrl.searchParams.get("src");
  const { cwd: srcCwd, cwdExists } = sourceCwdStatus(src);
  const conversations = (await listFiles())
    .filter((entry) => entry.path.endsWith(".jsonl") && (entry.root === "claude-projects" || entry.root === "codex-sessions"))
    .filter((entry) => !entry.path.includes(path.sep + "subagents" + path.sep))
    .sort((a, b) => Number(b.project === project) - Number(a.project === project) || b.mtime - a.mtime)
    .slice(0, SUGGEST_SCAN_LIMIT);

  const dirs: string[] = srcCwd ? [srcCwd] : [];
  if (!srcCwd) {
    for (const cwd of projectDirectoryCandidates(project, SUGGEST_MAX)) addDir(dirs, cwd, project);
  }
  for (const entry of conversations) {
    if (dirs.length >= SUGGEST_MAX) break;
    if (project && entry.project !== project) continue;
    const cwd = headCwd(entry.path, { requireDir: true });
    addDir(dirs, cwd, project);
  }
  if (!dirs.length) dirs.push(os.homedir());
  const transport = spawnTransport();
  return NextResponse.json({
    dirs,
    cwd: srcCwd,
    cwdExists,
    spawnTransport: transport,
    imageInput: {
      claude: runtimeImageCapability("claude", transport === "structured"),
      codex: runtimeImageCapability("codex", transport === "structured" && codexModelSupportsImages(null)),
    },
  });
}

export async function executeSpawnRequest(
  req: NextRequest,
  dependencies: SpawnCommandDependencies = productionSpawnCommandDependencies,
): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; model?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown; src?: unknown; parent?: unknown; parentConversationId?: unknown; effort?: unknown; fast?: unknown; accountId?: unknown; clientAttemptId?: unknown; role?: unknown; roleParams?: unknown; confirm?: unknown; reviews?: unknown; allowSubagents?: unknown; mcpServers?: unknown; plugins?: unknown; project?: unknown; supersedes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  /* Requested MCP grant (issue #739). A name outside the grantable bound is
     rejected here with 400, exactly like a rejected plugin, instead of being
     trimmed. Absence leaves the decision to policy; an explicit list — `[]`
     included — can only narrow what the session's origin already allows. */
  const mcpServers = normalizeSpawnMcpServers(body.mcpServers);
  if (!mcpServers.ok) return NextResponse.json({ error: mcpServers.error }, { status: 400 });
  const requestedMcpServers = body.mcpServers === undefined ? null : mcpServers.value;
  /* Requested plugin grant (issue #687). Absent leaves the decision to policy;
     `[]` is the operator's explicit opt-out for this root session. Anything
     outside the grantable set is rejected here, never trimmed silently. */
  const requestedPlugins = normalizeSpawnPlugins(body.plugins);
  if (!requestedPlugins.ok) return NextResponse.json({ error: requestedPlugins.error }, { status: 400 });

  const lineageError = agentSpawnLineageError(req, body);
  if (lineageError) return NextResponse.json({ error: lineageError }, { status: 400 });
  const agentInitiated = isAgentInitiatedSpawn(req);
  if (body.allowSubagents !== undefined && typeof body.allowSubagents !== "boolean") {
    return NextResponse.json({ error: "allowSubagents must be a boolean" }, { status: 400 });
  }
  const role = resolveSpawnRole(body);
  if (!role.ok) return NextResponse.json({ error: role.error }, { status: 400 });
  if (role.value?.role === "reviewer" && (typeof body.reviews !== "string" || !body.reviews.trim())) {
    return NextResponse.json({ error: "reviewer requires reviews" }, { status: 400 });
  }
  if (role.value?.role !== "reviewer" && body.reviews !== undefined) {
    return NextResponse.json({ error: "reviews requires role: reviewer" }, { status: 400 });
  }
  /* Reviewer isolation (#393): reviewer/verifier launch profiles always carry
     allowSubagents:false, so every engine denies native multi-agent tools on
     fresh launch, resume, and restart adoption. Even the operator lane cannot
     combine a denied role with subagent access. */
  if (role.value && isSpawnDeniedRole(role.value.role) && body.allowSubagents === true) {
    return NextResponse.json({ error: `${role.value.role} launches cannot enable subagents: reviewer and verifier sessions run every check in-session` }, { status: 400 });
  }
  const engine = body.engine === "claude" || body.engine === "codex"
    ? (body.engine as AgentEngine)
    : (role.value?.config.engine ?? null);
  if (!engine) return NextResponse.json({ error: "engine must be claude or codex" }, { status: 400 });
  if (body.accountId !== undefined && typeof body.accountId !== "string") return NextResponse.json({ error: "accountId must be a string" }, { status: 400 });
  if (body.clientAttemptId !== undefined && (typeof body.clientAttemptId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.clientAttemptId))) return NextResponse.json({ error: "clientAttemptId must be 8-128 URL-safe characters" }, { status: 400 });

  const reasoning = reasoningFromBody(engine, {
    ...body,
    effort: body.effort === undefined ? role.value?.config.effort : body.effort,
  });
  if (reasoning.error) return NextResponse.json({ error: reasoning.error }, { status: 400 });
  const selectedModel = modelFromBody({ model: body.model === undefined ? role.value?.config.model : body.model });
  if (selectedModel.error) return NextResponse.json({ error: selectedModel.error }, { status: 400 });
  if (body.model !== undefined && body.model !== null && selectedModel.model) {
    const validation = validateLaunchModel(engine, selectedModel.model);
    if ("error" in validation) return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const userPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const prompt = role.value ? [role.value.scaffold, userPrompt].filter(Boolean).join("\n\n") : userPrompt;
  const { images, error: imageError } = collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }
  let transport;
  try {
    transport = spawnTransport();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
  if (transport === "structured") {
    try {
      dependencies.assertStructuredRuntime();
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
    const gap = structuredSpawnGap({
      engine,
      model: selectedModel.model,
      hasImages: images.length > 0,
      fast: reasoning.fast,
    });
    if (gap) return NextResponse.json({ error: gap }, { status: 409 });
    /* The scaffold-composed prompt rides structured first-message delivery.
       Enforce its UTF-8 envelope before the durable receipt, blob storage,
       deferred launch, and 202 response. */
    try {
      assertStructuredTextEnvelope(prompt);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 413 });
    }
  }

  const registry = dependencies.registry();
  let authenticatedCaller: AuthenticatedSpawnCaller | null = null;
  if (agentInitiated) {
    const caller = authenticatedAgentSpawnCaller(req, body.src, registry);
    if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status ?? 403 });
    authenticatedCaller = caller;
  }
  if (agentInitiated && body.allowSubagents === true && authenticatedCaller?.kind !== "operator") {
    return NextResponse.json({ error: "allowSubagents requires an authenticated Viewer operator spawn" }, { status: 403 });
  }
  /* Explicit project ownership (issue #315): a deliberate operator decision,
     validated here and admitted as the conversation's durable projectOwnership.
     Sidebar selection or worker-initiated spawns never create ownership. */
  let explicitProject: string | null = null;
  if (body.project !== undefined && body.project !== null) {
    explicitProject = typeof body.project === "string" ? validExplicitProject(body.project) : null;
    if (!explicitProject) return NextResponse.json({ error: "project must be a valid project key" }, { status: 400 });
    if (agentInitiated && authenticatedCaller?.kind !== "operator") {
      return NextResponse.json({ error: "explicit project requires an authenticated Viewer operator spawn" }, { status: 403 });
    }
  }

  /* Supersedence admission (issue #383): the spawn terminally retires the
     named predecessor once it settles. The reference must resolve, a spawn
     can never supersede a conversation whose chain still ends live (the 409
     names it so the caller can redirect), and the durable edge itself commits
     only at settlement inside the registry. */
  let supersedesConversationId: `conversation_${string}` | null = null;
  if (body.supersedes !== undefined && body.supersedes !== null) {
    if (typeof body.supersedes !== "string" || !body.supersedes.trim()) {
      return NextResponse.json({ error: "supersedes must name a conversation id or transcript path" }, { status: 400 });
    }
    const reference = body.supersedes.trim();
    const predecessor = reference.startsWith("conversation_")
      ? registry.conversation(reference as `conversation_${string}`)
      : registry.conversationForPath(reference);
    if (!predecessor) {
      return NextResponse.json({ error: "supersedes does not resolve to a known conversation" }, { status: 404 });
    }
    const liveTail = registry.supersedenceConflict(predecessor.id);
    if (liveTail) {
      return NextResponse.json({
        error: `supersedes conflicts with the live conversation ${liveTail}`,
        successorConversationId: liveTail,
      }, { status: 409 });
    }
    supersedesConversationId = predecessor.id;
  }

  const rawCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!rawCwd) return NextResponse.json({ error: "working directory is required" }, { status: 400 });
  const cwd = path.resolve(rawCwd === "~" || rawCwd.startsWith("~/") ? path.join(os.homedir(), rawCwd.slice(1)) : rawCwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return NextResponse.json({ error: `directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: `not a directory: ${cwd}` }, { status: 400 });
  }

  const clientAttemptId = typeof body.clientAttemptId === "string" ? body.clientAttemptId : null;
  if (clientAttemptId && directOperatorActivityAuthority(req).ok) {
    try {
      dependencies.recordOperatorActivity?.({
        idempotencyKey: `spawn:${clientAttemptId}`,
        resolvedAttribution: {
          engine,
          project: explicitProject ?? projectForCwd(cwd) ?? UNRESOLVED_PROJECT,
        },
      });
    } catch {
      return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
    }
  }

  /* Saved paths stay visible to the catch. A pane-bound receipt keeps them:
     the agent may already have accepted the prompt despite a later failure. */
  let imagePaths: string[] = [];
  let launchId: string | null = null;
  try {
    const existingAttempt = clientAttemptId ? registry.spawnReceiptForClientAttempt(clientAttemptId) : null;
    const lineage = resolveSpawnLineage(spawnLineageSelectorForCaller(authenticatedCaller, {
      ...body,
      role: role.value?.role,
    }), registry);
    const parent = lineage.parent;
    const reviewedConversationId = lineage.reviewed?.conversationId ?? null;
    /* An authenticated agent caller always resolves its own conversation as
       parent; failure here means broken caller identity. An operator-capability
       caller without src proceeds as a silent root (#341) — the API lane now
       matches the UI lane's unmatched-caller fallback. */
    if (agentInitiated && authenticatedCaller?.kind === "agent" && !parent) {
      return NextResponse.json({ error: AGENT_SPAWN_LINEAGE_ERROR }, { status: 400 });
    }
    /* Parent attribution (#341): an explicit body selector wins and is
       recorded as such; an agent-lane parent that stood alone on the
       authenticated caller conversation is durably marked inferred. */
    const bodyCarriedSelector = authenticatedCaller?.kind === "agent"
      /* Agent lane: only the caller-verified `src` counts as explicit — other
         body selectors are ignored by the lane and never chose this parent. */
      ? typeof body.src === "string" && Boolean(body.src.trim())
      : (typeof body.src === "string" && Boolean(body.src.trim()))
        || (typeof body.parent === "string" && Boolean(body.parent.trim()))
        || body.parentConversationId !== undefined
        /* A UI/operator reviewer without src parents on the reviewed
           conversation — that selector also came from the request body. */
        || (typeof body.reviews === "string" && Boolean(body.reviews.trim()));
    const parentSource = parent ? (bodyCarriedSelector ? "explicit" as const : "inferred-caller" as const) : null;
    const parentConversationId = parent?.conversationId ?? null;
    const pipelineSourceConversationId = typeof body.src === "string" && body.src.trim()
      ? parentConversationId
      : null;
    const parentSessionKey = parent?.sessionKey ?? null;
    const parentArtifactPath = parent?.artifactPath ?? null;
    /* Session origin, and with it every grant this launch receives: an
       operator-launched root session is one with no agent caller, no lineage
       parent and no role preset. Plugins (#687) and MCP servers (#739) read the
       same classification, so a session cannot be a root for one and delegated
       for the other. */
    const sessionOrigin = sessionOriginFor({
      origin: { kind: authenticatedCaller?.kind === "agent" ? "agent" : "operator" },
      parentConversationId,
      agentRole: role.value?.role ?? null,
    });
    /* A Viewer-internal session class (#1086) REPLACES the origin defaults
       rather than adding to them: a report run whose grant has been revoked
       gets the baseline even though its launch would otherwise classify as an
       operator root. Only an in-process dependency can name it, and only a
       class listed here is honoured. */
    const internalGrant = dependencies.internalGrant?.() ?? null;
    const reportClassGrant = internalGrant?.sessionClass === SCHEDULED_REPORT_SESSION_CLASS
      ? internalGrant
      : null;
    /* An operator root carries the Computer Use grant by default; every
       delegated launch carries none, and the request can only narrow that. The
       report class carries none either: it names an exact capability surface,
       and a plugin is a channel outside it. */
    const plugins = reportClassGrant
      ? [...SCHEDULED_REPORT_PLUGINS]
      : pluginAllowlistForSession({
        engine,
        origin: sessionOrigin,
        requested: requestedPlugins.value,
      });
    /* Same shape for MCP: a delegated launch holds the Viewer baseline whatever
       it asked for, so a granted connector cannot travel down a spawn chain. */
    const grantedServers = reportClassGrant
      ? grantedMcpServers(reportClassGrant.mcpServers)
      : mcpServersForSession({ origin: sessionOrigin, requested: requestedMcpServers });
    const requestDigestForAccount = (accountId: string) => spawnRequestDigest({
      engine,
      cwd,
      model: selectedModel.model,
      effort: reasoning.effort,
      fast: reasoning.fast,
      accountId,
      role: role.value?.role ?? null,
      mcpServers: grantedServers,
      ...(plugins.length ? { plugins } : {}),
      ...(body.allowSubagents === true ? { allowSubagents: true } : {}),
      ...(explicitProject ? { project: explicitProject } : {}),
      parent: spawnParentSelector({ parentConversationId: parentConversationId ?? undefined }),
      ...(reviewedConversationId ? { reviews: spawnParentSelector({ parentConversationId: reviewedConversationId }) } : {}),
      ...(supersedesConversationId ? { supersedes: spawnParentSelector({ parentConversationId: supersedesConversationId }) } : {}),
      prompt,
      images: images.map((image) => ({ mime: image.mime, digest: spawnContentDigest({ image: image.base64 }) })),
    });
    const pipelineAttemptTarget = pipelineSourceConversationId && dependencies.pipelineAttemptTargetForSource
      ? dependencies.pipelineAttemptTargetForSource(pipelineSourceConversationId)
      : null;
    /* The durable display copy of the prompt is skipped for a report run
       (#1086): its prompt carries the operator's own analyst brief, which may
       name their private chats, and the issue's fence keeps registry rows down
       to status, window and error code. The board card still reads its title
       from the scanned transcript, whose first line names the run. */
    const launchDisplay = (!reportClassGrant && (userPrompt.trim() || images.length))
      ? { ["prompt"]: userPrompt, images: images.length, echo: prompt }
      : null;
    /* Both a runnable launch and an explicit-account preflight failure reserve
       the same durable launch identity. Keep the request assembled at this
       seam so the terminal receipt retains the lineage, origin, grants and
       pipeline evidence a runnable receipt would carry. */
    const canonicalSpawnRequest = (
      accountId: string,
      launchProfile: ReturnType<typeof emptyLaunchProfile>,
      requestDigest: string,
      accountPin = body.accountId !== undefined,
    ): SpawnRequest => ({
      engine,
      cwd,
      transport,
      accountId,
      accountPin,
      parentConversationId,
      parentSource,
      parentSessionKey,
      parentArtifactPath,
      role: role.value?.role ?? null,
      reviewsConversationId: reviewedConversationId,
      explicitProject,
      supersedes: supersedesConversationId,
      supersedesReason: "recovery-spawn",
      liveChildrenCap: authenticatedCaller?.liveChildrenCap,
      /* Initiating origin (#393): the authenticated capability caller is the
         origin of agent-lane launches; same-origin UI and operator-capability
         launches are depth-0 roots. Lineage parents stay projection metadata. */
      origin: authenticatedCaller?.kind === "agent"
        ? { kind: "agent", conversationId: authenticatedCaller.conversationId }
        : { kind: "operator" },
      launchProfile,
      clientAttemptId,
      requestDigest,
      /* Durable launch DISPLAY payload (issue #614/#615): the RAW operator
         draft and canonical delivered echo persist through scan lag. */
      launchDisplay,
      memberships: pipelineAttemptTarget && pipelineSourceConversationId ? [{
        kind: "pipeline",
        containerId: pipelineAttemptTarget.pipelineId,
        role: pipelineAttemptTarget.role,
        slot: `adopt:${pipelineAttemptTarget.stageId}:${requestDigest.slice(0, 24)}`,
        stageId: pipelineAttemptTarget.stageId,
        stageOrder: pipelineAttemptTarget.stageOrder,
        round: null,
        parentConversationId: pipelineSourceConversationId as `conversation_${string}`,
        runtime: {
          engine,
          model: launchProfile.model,
          effort: launchProfile.effort,
        },
      }] : [],
    });
    const preflightLaunchProfile = emptyLaunchProfile({
      cwd,
      model: selectedModel.model,
      effort: reasoning.effort,
      fast: reasoning.fast,
      parentConversationId,
      allowSubagents: body.allowSubagents === true,
      mcpServers: grantedServers,
      plugins,
      ...(explicitProject ? { project: explicitProject } : {}),
    });
    const terminalizePinnedAccountFailure = (failure: unknown): NextResponse<SpawnResponse | ApiError> => {
      const accountId = body.accountId as string;
      const reason = (failure instanceof Error ? failure.message : String(failure)).slice(0, 240);
      const begun = registry.beginSpawnRequest(canonicalSpawnRequest(
        accountId,
        preflightLaunchProfile,
        /* The digest binds this terminal preflight to the same canonical public
           launch identity as a runnable request. Prompt and image bytes enter
           durable identity only through one-way hashes. */
        requestDigestForAccount(accountId),
      ));
      if (begun.kind === "conflict") {
        return NextResponse.json({ error: "spawn attempt conflicts with its original request" }, { status: 409 });
      }
      if (begun.kind === "created") {
        if (transport === "structured") registry.failStructuredSpawn(begun.receipt.launchId, reason);
        else registry.failSpawn(begun.receipt.launchId, reason);
      }
      const receipt = registry.readOnlySnapshot().receipts[begun.receipt.launchId] ?? begun.receipt;
      return NextResponse.json(spawnResponseForReceipt(receipt, receipt.artifactPath, {
        structured: transport === "structured",
      }));
    };
    if (existingAttempt
      && body.accountId !== undefined
      && existingAttempt.accountPin
      && (existingAttempt.state === "failed" || existingAttempt.state === "conflicted")) {
      return terminalizePinnedAccountFailure(
        new Error(existingAttempt.error ?? "the requested account is not available for this launch"),
      );
    }
    const requestedAccountId = typeof body.accountId === "string" ? body.accountId : null;
    let account: HealthySpawnAccountResolution;
    try {
      account = existingAttempt && existingAttempt.accountId !== null && !(existingAttempt.accountPin && requestedAccountId)
        ? dependencies.resolveSpawnAccount(existingAttempt.engine, existingAttempt.accountId)
        : await dependencies.resolveHealthySpawnAccount(engine, body.accountId);
    } catch (error) {
      if (body.accountId === undefined) throw error;
      if (engine === "claude" && requestedAccountId) {
        try {
          const pinned = dependencies.resolveSpawnAccount(engine, requestedAccountId);
          const admission = await (dependencies.resolvePinnedSpawnAdmission ?? resolvePinnedSpawnAdmission)(engine, pinned);
          if (admission.kind === "retry-at" || admission.kind === "admissible") {
            account = { ...pinned, admission, requestedAdmission: admission };
          } else {
            return terminalizePinnedAccountFailure(error);
          }
        } catch {
          return terminalizePinnedAccountFailure(error);
        }
      } else {
        return terminalizePinnedAccountFailure(error);
      }
    }
    const requestedRetryAt = requestedAccountId && account.requestedAdmission?.kind === "retry-at"
      ? account.requestedAdmission.retryAt
      : null;
    const retryDeadline = requestedRetryAt ? Date.parse(requestedRetryAt) : Number.NaN;
    const queuedUntil = Number.isFinite(retryDeadline) && retryDeadline > Date.now()
      ? new Date(retryDeadline).toISOString()
      : null;
    if (queuedUntil && requestedAccountId) {
      account = dependencies.resolveSpawnAccount(engine, requestedAccountId);
    }
    const pinFallback = Boolean(requestedAccountId && !queuedUntil && account.accountId !== requestedAccountId);
    /* Idempotency binds the caller's requested account even when policy
       degrades that pin to a fallback account. A replay can therefore recover
       the admitted fallback while a changed pin still conflicts. */
    const digest = requestDigestForAccount(
      typeof body.accountId === "string" ? body.accountId : account.accountId,
    );
    const specForAccount = (
      launchAccount: HealthySpawnAccountResolution,
      title: string | null,
    ) => {
      const specBase = freshSpecFor(engine, cwd, {
        model: selectedModel.model,
        effort: reasoning.effort,
        fast: reasoning.fast,
        codexHome: engine === "codex" ? launchAccount.home : null,
        claudeConfigDir: engine === "claude" ? launchAccount.home : null,
        claudeProjectsDir: engine === "claude" ? launchAccount.transcriptRoot : null,
        allowSubagents: body.allowSubagents === true,
        mcpServers: grantedServers,
        deferClaudeSpawnPolicy: true,
      });
      const permissionMode = engine === "claude" && transport === "structured"
        ? structuredClaudePermissionMode(specBase.launchProfile?.permissionMode, {
          agentInitiated,
          operatorAuthenticated: authenticatedCaller?.kind === "operator",
          roleSpawn: Boolean(role.value),
        })
        : specBase.launchProfile?.permissionMode;
      return {
        ...specBase,
        launchProfile: emptyLaunchProfile({
          ...(specBase.launchProfile ?? {}),
          cwd,
          parentConversationId,
          allowSubagents: body.allowSubagents === true,
          mcpServers: grantedServers,
          plugins,
          permissionMode,
          ...(title ? { title } : {}),
          ...(explicitProject ? { project: explicitProject } : {}),
        }),
      };
    };
    const queuedTitle = queuedUntil
      ? queuedPinnedSpawnTitle(prefersUkrainian(req) ? "uk" : "en", queuedUntil)
      : null;
    const pinTitle = pinFallback ? pinFallbackTitle(req) : null;
    const spec = specForAccount(account, pinTitle);
    const prepareTmuxSpawn = (): void => {
      if (engine !== "claude" || transport !== "tmux") return;
      const profileId = path.basename(spec.transcript ?? "", ".jsonl");
      if (isManagedClaudeHome(account.home)) prepareManagedClaudeSpawnHome(account.home, cwd);
      applyClaudeSpawnPolicy(account.home, {
        allowSubagents: body.allowSubagents === true,
        baseSettingsPath: isManagedClaudeHome(account.home) ? claudeSettingsPath() : null,
        profileId,
        cwd,
        mcpServers: grantedServers,
        mcpStatePath: account.kind === "managed"
          ? path.join(account.home, ".claude.json")
          : path.join(path.dirname(account.home), ".claude.json"),
      });
    };
    /* The receipt keeps the caller's requested account as durable routing
       authority. The separate account context below owns this generation's
       actual launch, so a degraded fallback cannot silently rebind the pin. */
    const receiptAccountId = pinFallback && typeof body.accountId === "string"
      ? body.accountId
      : account.accountId;
    const begun = registry.beginSpawnRequest(canonicalSpawnRequest(
      receiptAccountId,
      spec.launchProfile,
      digest,
      existingAttempt?.accountPin ?? (body.accountId !== undefined),
    ));
    if (begun.kind === "conflict") return NextResponse.json({ error: "spawn attempt conflicts with its original request" }, { status: 409 });
    if (begun.kind === "created") launchId = begun.receipt.launchId;
    let queuedReceipt = begun.receipt;
    if (queuedUntil && queuedTitle && requestedAccountId) {
      const existingQueue = begun.receipt.queuedPinnedSpawn;
      let queuedImageRefs: StructuredImageRef[];
      if (existingQueue) {
        queuedImageRefs = existingQueue.imageRefs;
      } else {
        try { queuedImageRefs = dependencies.storeImages(images); }
        catch (error) { throw new RuntimeImageStorageError(error instanceof Error ? error.message : String(error)); }
      }
      queuedReceipt = registry.queuePinnedSpawn(begun.receipt.launchId, {
        version: 1,
        retryAt: queuedUntil,
        accountId: requestedAccountId,
        locale: prefersUkrainian(req) ? "uk" : "en",
        spec,
        ["prompt"]: prompt,
        imageRefs: queuedImageRefs,
        parentArtifactPath,
        pipelineSourceConversationId,
      }, queuedTitle);
    }
    const recordActualLaunchAccount = (
      receipt: typeof begun.receipt,
      actualAccountId: string,
      agentPath: string | null,
    ): void => {
      if (!agentPath || receipt.accountId === actualAccountId) return;
      const snapshot = registry.readOnlySnapshot();
      const materialized = snapshot.receipts[receipt.launchId];
      if (!materialized?.key || materialized.artifactPath !== agentPath) return;
      const entry = snapshot.entries[sessionKeyId(materialized.key)];
      const conversation = snapshot.conversations[materialized.conversationId];
      if (!entry || !conversation) return;
      registry.reconcileConversations([{
        engine: materialized.engine,
        path: agentPath,
        accountId: actualAccountId,
        launchProfile: materialized.launchProfile,
        turn: {
          state: conversation.turn.state,
          source: conversation.turn.source,
          terminalAt: conversation.turn.terminalAt,
        },
        expectedTurnObservedAt: conversation.turn.observedAt,
        observedAt: new Date().toISOString(),
      }]);
      registry.upsert({ ...entry, accountId: actualAccountId });
    };
    const adoptMaterializedAttempt = async (receipt: typeof begun.receipt, agentPath: string): Promise<void> => {
      if (!pipelineSourceConversationId || !dependencies.adoptPipelineAttemptFromSource) return;
      const materialized = registry.readOnlySnapshot().receipts[receipt.launchId] ?? receipt;
      try {
        await dependencies.adoptPipelineAttemptFromSource(pipelineSourceConversationId, {
          launchId: materialized.launchId,
          conversationId: materialized.conversationId,
          sessionId: materialized.key?.sessionId ?? null,
          agentPath,
          paneId: materialized.verifiedHost?.paneId ?? materialized.pane?.paneId ?? null,
          startedAt: materialized.createdAt,
          runtime: {
            engine: materialized.engine,
            model: materialized.launchProfile.model,
            effort: materialized.launchProfile.effort,
          },
        });
      } catch (error) {
        console.error("[spawn] pipeline attempt adoption failed", {
          launchId: materialized.launchId,
          conversationId: materialized.conversationId,
          sourceConversationId: pipelineSourceConversationId,
          error,
        });
      }
    };
    const deferStructuredSpawn = (
      receipt: typeof begun.receipt,
      runtimeClient: NonNullable<ReturnType<typeof dependencies.runtimeHostClient>>,
      imageRefs: StructuredImageRef[],
    ): void => {
      dependencies.defer(async () => {
        let response: SpawnResponse;
        try {
          response = await dependencies.spawnStructuredConversation({
            engine,
            receipt,
            spec,
            account,
            prompt,
            imageRefs,
            registry,
            client: runtimeClient,
          });
          recordActualLaunchAccount(receipt, account.accountId, response.path);
        } catch (error) {
          console.error("[spawn] structured launch failed", {
            launchId: receipt.launchId,
            conversationId: receipt.conversationId,
            error,
          });
          /* Structured is the default transport now, and this injected launch
             seam can still throw before it records a durable result. Preserve a
             route-level transport fallback so tests, older launch adapters, and
             partial upgrades still turn an accepted 202 into a terminal card.
             Retry-safe:
             `failStructuredSpawn` no-ops on an already-terminal receipt, and a
             failed launch is claimable for retry under the same launch id, so
             a transient blip cannot become a second launch. */
          if (error instanceof RuntimeHostUnavailableError) {
            registry.failStructuredSpawn(
              receipt.launchId,
              `structured spawn transport failed: ${error.message}`.slice(0, 240),
            );
          }
          return;
        }
        if (parentArtifactPath && response.path) {
          try {
            rememberHandoffChild(response.path, parentArtifactPath);
            persistHandoffLineage();
          } catch (error) {
            console.error("[spawn] handoff lineage persistence failed", {
              launchId: receipt.launchId,
              conversationId: receipt.conversationId,
              childArtifactPath: response.path,
              parentArtifactPath,
              error,
            });
          }
        }
        if (response.path) await adoptMaterializedAttempt(receipt, response.path);
        if (response.path && fs.existsSync(response.path)) {
          try {
            await dependencies.publishFilesRevision?.(runtimeClient);
          } catch (error) {
            console.error("[spawn] transcript materialization refresh failed", {
              launchId: receipt.launchId,
              conversationId: receipt.conversationId,
              artifactPath: response.path,
              error,
            });
          }
        }
      });
    };
    if (begun.kind === "replay") {
      const structured = queuedReceipt.transport === "structured"
        || (queuedReceipt.transport === null
          && Boolean(queuedReceipt.key && registry.readOnlySnapshot().entries[sessionKeyId(queuedReceipt.key)]?.structuredHost));
      let receipt = queuedReceipt;
      let initialMessage: SpawnResponse["initialMessage"] | undefined;
      const runtimeClient = structured ? dependencies.runtimeHostClient() : null;
      if (runtimeClient && !queuedUntil) {
        try {
          const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, registry, runtimeClient);
          receipt = reconciled;
          initialMessage = reconciled.initialMessage;
        } catch {
          /* The durable registry receipt remains available during runtime resynchronization. */
        }
        const admission = registry.claimStartingStructuredSpawn(receipt.launchId);
        receipt = admission.receipt;
        if (admission.claimed) {
          let imageRefs;
          try { imageRefs = dependencies.storeImages(images); }
          catch (error) {
            /* No deferred work exists after this rejection. A compare-and-set
               release lets the next retry claim the lease immediately. */
            if (admission.receipt.admissionOwner) {
              registry.releaseStartingStructuredSpawn(receipt.launchId, admission.receipt.admissionOwner);
            }
            throw new RuntimeImageStorageError(error instanceof Error ? error.message : String(error));
          }
          deferStructuredSpawn(receipt, runtimeClient, imageRefs);
        }
      }
      if (receipt.artifactPath) await adoptMaterializedAttempt(receipt, receipt.artifactPath);
      const response = spawnResponseForReceipt(receipt, receipt.artifactPath, {
        structured,
        initialMessage: queuedUntil ? "queued" : initialMessage,
      });
      return NextResponse.json(response, { status: spawnReplayStatus(response, structured) });
    }
    if (queuedUntil) {
      prepareTmuxSpawn();
      const releasedQueuedReceipt = queuedReceipt.admissionOwner
        ? registry.releaseSpawnActuation(queuedReceipt.launchId, queuedReceipt.admissionOwner).receipt
        : queuedReceipt;
      return NextResponse.json(
        spawnResponseForReceipt(releasedQueuedReceipt, releasedQueuedReceipt.artifactPath, {
          structured: transport === "structured",
          initialMessage: "queued",
        }),
        { status: 202 },
      );
    }
    prepareTmuxSpawn();
    if (transport === "structured") {
      const runtimeClient = dependencies.runtimeHostClient();
      if (!runtimeClient) throw new Error("structured spawn runtime host is unavailable");
      let imageRefs;
      try { imageRefs = dependencies.storeImages(images); }
      catch (error) { throw new RuntimeImageStorageError(error instanceof Error ? error.message : String(error)); }
      deferStructuredSpawn(begun.receipt, runtimeClient, imageRefs);
      return NextResponse.json(
        spawnResponseForReceipt(begun.receipt, begun.receipt.artifactPath, {
          structured: true,
        }),
        { status: 202 },
      );
    }
    /* Pasted images land in the inbox and reach the fresh agent as file paths
       appended to its first prompt — the same contract the pane composer uses. */
    const bundle = buildImagePayload(prompt, images);
    imagePaths = bundle.imagePaths;
    let runtimeClient = runtimeEventsEnabled() ? dependencies.runtimeHostClient() : null;
    /* The durable launch receipt owns the runtime idempotency key too. A
       recovered route cannot create a second logical lineage edge. */
    const operationId = runtimeClient ? begun.receipt.launchId : null;
    if (runtimeClient && operationId) {
      try {
        await runtimeClient.operation({
          scope: runtimeScope("operation", operationId),
          kind: "spawn.intent",
          operationId,
          producerKey: `viewer-spawn:${operationId}`,
          payload: { engine, cwd, accountId: account.accountId, parentConversationId },
        });
      } catch {
        console.warn("[runtime] spawn bookkeeping unavailable; continuing through the legacy spawn path");
        runtimeClient = null;
      }
    }
    const startedAtMs = Date.now();
    const pane = await (dependencies.spawnTmuxAgent ?? spawnAgentWithPrompt)(spec, bundle.payload, begun.receipt);
    const childPath = await resolveSpawnedTranscriptPath({
      engine,
      knownTranscript: spec.transcript ?? null,
      panePid: pane.panePid ?? null,
      cwd,
      startedAtMs,
      codexSessionsDir: engine === "codex" ? account.transcriptRoot : null,
    });
    const key = childPath ? sessionKeyFromTranscript(engine, childPath) : null;
    if (!pane.host || !await verifyTmuxHostEvidence(pane.host)) {
      agentRegistry().invalidateSpawnHost(begun.receipt.launchId, "spawn host disappeared before API confirmation");
      const lost = agentRegistry().readOnlySnapshot().receipts[begun.receipt.launchId]!;
      return NextResponse.json(spawnResponseForReceipt(lost, childPath));
    }
    if (!childPath || !key || !pane.receipt) {
      const pending = agentRegistry().markSpawnPathPending(begun.receipt.launchId);
      return NextResponse.json(spawnResponseForReceipt(pending, null));
    }
    const settled = agentRegistry().settleSpawn(pane.receipt.launchId, {
      key,
      artifactPath: childPath,
      cwd,
      accountId: account.accountId,
      status: "starting",
      host: pane.host,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    if (settled.kind === "conflict") return NextResponse.json(spawnResponseForReceipt(settled.receipt));
    recordActualLaunchAccount(settled.receipt, account.accountId, childPath);
    await adoptMaterializedAttempt(settled.receipt, childPath);
    if (runtimeClient && operationId) {
      try {
        await runtimeClient.append({
          scope: runtimeScope("edge", operationId),
          kind: "edge.created",
          producerKey: `viewer-spawn-edge:${operationId}`,
          payload: {
            edge: "viewer_spawn",
            childConversationId: settled.conversation.id,
            parentConversationId,
            operationId,
          },
        });
      } catch {
        console.warn("[runtime] spawned agent is healthy; lineage bookkeeping will reconcile later");
      }
    }
    if (parentArtifactPath) {
      if (childPath) rememberHandoffChild(childPath, parentArtifactPath);
      persistHandoffLineage();
    }
    if (!await verifyTmuxHostEvidence(pane.host)) {
      agentRegistry().invalidateSpawnHost(begun.receipt.launchId, "spawn host disappeared before API response");
      const lost = agentRegistry().readOnlySnapshot().receipts[begun.receipt.launchId]!;
      return NextResponse.json(spawnResponseForReceipt(lost, childPath));
    }
    return NextResponse.json(spawnResponseForReceipt(settled.receipt, childPath));
  } catch (error) {
    const receipt = launchId ? registry.readOnlySnapshot().receipts[launchId] : null;
    if (!receipt || receipt.pane === null) {
      if (receipt) registry.failSpawn(receipt.launchId, "spawn failed before pane binding");
      deleteInboxImages(imagePaths);
    }
    if (error instanceof SpawnParentError) return NextResponse.json({ error: error.message }, { status: error.status });
    /* Typed terminal admission rejection (#393): the durable receipt already
       exists and no transcript or process was created. */
    if (error instanceof SpawnAdmissionError) return NextResponse.json(spawnRejectionResponse(error), { status: 403 });
    if (error instanceof SpawnChildLimitError) return NextResponse.json({ error: error.message }, { status: 429 });
    if (error instanceof RuntimeImageStorageError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (error instanceof UnknownAccountError || error instanceof UnknownClaudeAccountError) return NextResponse.json({ error: error.message }, { status: 400 });
    const accountError = spawnAccountErrorResponse(error);
    if (accountError) return accountError;
    if (receipt?.pane) {
      if (receipt.state === "prompt-delivered" || receipt.state === "host-verified") registry.markSpawnPathPending(receipt.launchId);
      const recovered = registry.readOnlySnapshot().receipts[receipt.launchId];
      if (recovered) return NextResponse.json(spawnResponseForReceipt(recovered, recovered.artifactPath));
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
