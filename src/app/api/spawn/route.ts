import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { after, NextRequest, NextResponse } from "next/server";

import { UnknownAccountError } from "@/lib/accounts/codex";
import { claudeSettingsPath, isManagedClaudeHome, UnknownClaudeAccountError } from "@/lib/accounts/claude";
import { accountManager, resolveHealthySpawnAccount } from "@/lib/accounts/manager";
import { emptyLaunchProfile, validExplicitProject } from "@/lib/accounts/migration/contracts";
import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { agentRegistry, SpawnChildLimitError } from "@/lib/agent/registry";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { codexModelSupportsImages, modelFromBody } from "@/lib/agent/models";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { assertDarwinStructuredRuntime } from "@/lib/proc/darwinIdentity";
import { spawnContentDigest, spawnParentSelector, spawnRequestDigest } from "@/lib/agent/spawnIdentity";
import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { resolveSpawnLineage, SpawnParentError } from "@/lib/agent/spawnParent";
import { spawnReplayStatus, spawnResponseForReceipt, type SpawnResponse } from "@/lib/agent/spawnResponse";
import { applyClaudeSpawnPolicy, prepareManagedClaudeSpawnHome } from "@/lib/agent/spawnPolicy";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeScope } from "@/lib/runtime/contracts";
import { publishFilesRevision } from "@/lib/runtime/filesRevision";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { runtimeImageCapability, runtimeImageStore, type RuntimeImageUpload } from "@/lib/runtime/runtimeImageStore";
import { assertStructuredTextEnvelope, type StructuredImageRef } from "@/lib/runtime/structuredContent";
import { reconcileStructuredSpawnReplay, spawnStructuredConversation, structuredClaudePermissionMode } from "@/lib/runtime/structuredSpawn";
import { structuredSpawnGap, spawnTransport } from "@/lib/runtime/spawnTransport";
import { listFiles } from "@/lib/scanner";
import { projectForCwd } from "@/lib/scanner/describe";
import { projectDirectoryCandidates } from "@/lib/scanner/projectDirectories";
import { buildImagePayload, collectImagePayloads, deleteInboxImages, spawnAgentWithPrompt, verifyTmuxHostEvidence } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

import { sourceCwdStatus } from "./sourceCwd";
import { AGENT_SPAWN_LINEAGE_ERROR, agentSpawnLineageError, authenticatedAgentSpawnCaller, isAgentInitiatedSpawn, spawnLineageSelectorForCaller, type AuthenticatedSpawnCaller } from "./admission";
import { spawnAccountErrorResponse } from "./accountError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_SCAN_LIMIT = 80;
const SUGGEST_MAX = 10;

interface SpawnRouteDependencies {
  registry: typeof agentRegistry;
  resolveHealthySpawnAccount: typeof resolveHealthySpawnAccount;
  resolveSpawnAccount: typeof accountManager.resolveSpawn;
  runtimeHostClient: typeof runtimeHostClient;
  publishFilesRevision?: typeof publishFilesRevision;
  spawnStructuredConversation: typeof spawnStructuredConversation;
  assertStructuredRuntime: typeof assertDarwinStructuredRuntime;
  defer(work: () => Promise<void>): void;
  storeImages(images: readonly RuntimeImageUpload[]): StructuredImageRef[];
}

class RuntimeImageStorageError extends Error {}

const productionSpawnRouteDependencies: SpawnRouteDependencies = {
  registry: agentRegistry,
  resolveHealthySpawnAccount,
  resolveSpawnAccount: (engine, accountId) => accountManager.resolveSpawn(engine, accountId),
  runtimeHostClient,
  publishFilesRevision,
  spawnStructuredConversation,
  assertStructuredRuntime: assertDarwinStructuredRuntime,
  defer: (work) => after(work),
  storeImages: (images) => runtimeImageStore().putMany(images),
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
export async function GET(req: NextRequest): Promise<NextResponse<SuggestResponse>> {
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

async function postSpawn(
  req: NextRequest,
  dependencies: SpawnRouteDependencies = productionSpawnRouteDependencies,
): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; model?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown; src?: unknown; parent?: unknown; parentConversationId?: unknown; effort?: unknown; fast?: unknown; accountId?: unknown; clientAttemptId?: unknown; role?: unknown; roleParams?: unknown; confirm?: unknown; reviews?: unknown; allowSubagents?: unknown; project?: unknown; supersedes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

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

  /* Saved paths stay visible to the catch. A pane-bound receipt keeps them:
     the agent may already have accepted the prompt despite a later failure. */
  let imagePaths: string[] = [];
  let launchId: string | null = null;
  try {
    const clientAttemptId = typeof body.clientAttemptId === "string" ? body.clientAttemptId : null;
    const existingAttempt = clientAttemptId ? registry.spawnReceiptForClientAttempt(clientAttemptId) : null;
    const account = existingAttempt && body.accountId === undefined && existingAttempt.accountId !== null
      ? dependencies.resolveSpawnAccount(existingAttempt.engine, existingAttempt.accountId)
      : await dependencies.resolveHealthySpawnAccount(engine, body.accountId);
    const lineage = resolveSpawnLineage(spawnLineageSelectorForCaller(authenticatedCaller, {
      ...body,
      role: role.value?.role,
    }), registry);
    const parent = lineage.parent;
    const reviewedConversationId = lineage.reviewed?.conversationId ?? null;
    if (agentInitiated && !parent) return NextResponse.json({ error: AGENT_SPAWN_LINEAGE_ERROR }, { status: 400 });
    const parentConversationId = parent?.conversationId ?? null;
    const parentSessionKey = parent?.sessionKey ?? null;
    const parentArtifactPath = parent?.artifactPath ?? null;
    const digest = spawnRequestDigest({
      engine,
      cwd,
      model: selectedModel.model,
      effort: reasoning.effort,
      fast: reasoning.fast,
      accountId: account.accountId,
      role: role.value?.role ?? null,
      ...(body.allowSubagents === true ? { allowSubagents: true } : {}),
      ...(explicitProject ? { project: explicitProject } : {}),
      parent: spawnParentSelector({ parentConversationId: parentConversationId ?? undefined }),
      ...(reviewedConversationId ? { reviews: spawnParentSelector({ parentConversationId: reviewedConversationId }) } : {}),
      ...(supersedesConversationId ? { supersedes: spawnParentSelector({ parentConversationId: supersedesConversationId }) } : {}),
      prompt,
      images: images.map((image) => ({ mime: image.mime, digest: spawnContentDigest({ image: image.base64 }) })),
    });
    const specBase = freshSpecFor(engine, cwd, {
      model: selectedModel.model,
      effort: reasoning.effort,
      fast: reasoning.fast,
      codexHome: engine === "codex" ? account.home : null,
      claudeConfigDir: engine === "claude" ? account.home : null,
      claudeProjectsDir: engine === "claude" ? account.transcriptRoot : null,
      allowSubagents: body.allowSubagents === true,
      deferClaudeSpawnPolicy: true,
    });
    const permissionMode = engine === "claude" && transport === "structured"
      ? structuredClaudePermissionMode(specBase.launchProfile?.permissionMode, {
        agentInitiated,
        operatorAuthenticated: authenticatedCaller?.kind === "operator",
        roleSpawn: Boolean(role.value),
      })
      : specBase.launchProfile?.permissionMode;
    const spec = {
      ...specBase,
      launchProfile: emptyLaunchProfile({
        ...(specBase.launchProfile ?? {}),
        cwd,
        parentConversationId,
        allowSubagents: body.allowSubagents === true,
        permissionMode,
        ...(explicitProject ? { project: explicitProject } : {}),
      }),
    };
    const begun = registry.beginSpawnRequest({
      engine,
      cwd,
      transport,
      accountId: account.accountId,
      parentConversationId,
      parentSessionKey,
      parentArtifactPath,
      role: role.value?.role ?? null,
      reviewsConversationId: reviewedConversationId,
      explicitProject,
      supersedes: supersedesConversationId,
      supersedesReason: "recovery-spawn",
      liveChildrenCap: authenticatedCaller?.liveChildrenCap,
      launchProfile: spec.launchProfile,
      clientAttemptId,
      requestDigest: digest,
    });
    if (begun.kind === "conflict") return NextResponse.json({ error: "spawn attempt conflicts with its original request" }, { status: 409 });
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
        } catch (error) {
          console.error("[spawn] structured launch failed", {
            launchId: receipt.launchId,
            conversationId: receipt.conversationId,
            error,
          });
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
      const structured = begun.receipt.transport === "structured"
        || (begun.receipt.transport === null
          && Boolean(begun.receipt.key && registry.snapshot().entries[sessionKeyId(begun.receipt.key)]?.structuredHost));
      let receipt = begun.receipt;
      let initialMessage: SpawnResponse["initialMessage"] | undefined;
      const runtimeClient = structured ? dependencies.runtimeHostClient() : null;
      if (runtimeClient) {
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
      const response = spawnResponseForReceipt(receipt, receipt.artifactPath, { structured, initialMessage });
      return NextResponse.json(response, { status: spawnReplayStatus(response, structured) });
    }
    launchId = begun.receipt.launchId;
    if (engine === "claude" && transport === "tmux") {
      const profileId = path.basename(spec.transcript ?? "", ".jsonl");
      if (isManagedClaudeHome(account.home)) prepareManagedClaudeSpawnHome(account.home, cwd);
      applyClaudeSpawnPolicy(account.home, {
        allowSubagents: body.allowSubagents === true,
        baseSettingsPath: isManagedClaudeHome(account.home) ? claudeSettingsPath() : null,
        profileId,
      });
    }
    if (transport === "structured") {
      const runtimeClient = dependencies.runtimeHostClient();
      if (!runtimeClient) throw new Error("structured spawn runtime host is unavailable");
      let imageRefs;
      try { imageRefs = dependencies.storeImages(images); }
      catch (error) { throw new RuntimeImageStorageError(error instanceof Error ? error.message : String(error)); }
      deferStructuredSpawn(begun.receipt, runtimeClient, imageRefs);
      return NextResponse.json(
        spawnResponseForReceipt(begun.receipt, begun.receipt.artifactPath, { structured: true }),
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
    const pane = await spawnAgentWithPrompt(spec, bundle.payload, begun.receipt);
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
      const lost = agentRegistry().snapshot().receipts[begun.receipt.launchId]!;
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
      const lost = agentRegistry().snapshot().receipts[begun.receipt.launchId]!;
      return NextResponse.json(spawnResponseForReceipt(lost, childPath));
    }
    return NextResponse.json(spawnResponseForReceipt(settled.receipt, childPath));
  } catch (error) {
    const receipt = launchId ? agentRegistry().snapshot().receipts[launchId] : null;
    if (!receipt || receipt.pane === null) {
      if (receipt) agentRegistry().failSpawn(receipt.launchId, "spawn failed before pane binding");
      deleteInboxImages(imagePaths);
    }
    if (error instanceof SpawnParentError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SpawnChildLimitError) return NextResponse.json({ error: error.message }, { status: 429 });
    if (error instanceof RuntimeImageStorageError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (error instanceof UnknownAccountError || error instanceof UnknownClaudeAccountError) return NextResponse.json({ error: error.message }, { status: 400 });
    const accountError = spawnAccountErrorResponse(error);
    if (accountError) return accountError;
    if (receipt?.pane) {
      if (receipt.state === "prompt-delivered" || receipt.state === "host-verified") agentRegistry().markSpawnPathPending(receipt.launchId);
      const recovered = agentRegistry().snapshot().receipts[receipt.launchId];
      if (recovered) return NextResponse.json(spawnResponseForReceipt(recovered, recovered.artifactPath));
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export const POST = Object.assign(
  async (req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> => await postSpawn(req),
  { withDependencies: postSpawn },
);
