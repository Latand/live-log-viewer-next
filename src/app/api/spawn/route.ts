import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { UnknownAccountError } from "@/lib/accounts/codex";
import { claudeSettingsPath, isManagedClaudeHome, UnknownClaudeAccountError } from "@/lib/accounts/claude";
import { accountManager, resolveHealthySpawnAccount } from "@/lib/accounts/manager";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { freshSpecFor, type AgentEngine } from "@/lib/agent/cli";
import { agentRegistry, SpawnChildLimitError } from "@/lib/agent/registry";
import { reasoningFromBody } from "@/lib/agent/efforts";
import { modelFromBody } from "@/lib/agent/models";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { spawnContentDigest, spawnParentSelector, spawnRequestDigest } from "@/lib/agent/spawnIdentity";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { resolveSpawnLineage, SpawnParentError } from "@/lib/agent/spawnParent";
import { spawnResponseForReceipt, type SpawnResponse } from "@/lib/agent/spawnResponse";
import { applyClaudeSpawnPolicy, prepareManagedClaudeSpawnHome } from "@/lib/agent/spawnPolicy";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeScope } from "@/lib/runtime/contracts";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { listFiles } from "@/lib/scanner";
import { projectForCwd } from "@/lib/scanner/describe";
import { projectDirectoryCandidates } from "@/lib/scanner/projectDirectories";
import { buildImagePayload, collectImagePayloads, deleteInboxImages, spawnAgentWithPrompt, verifyTmuxHostEvidence } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

import { sourceCwdStatus } from "./sourceCwd";
import { AGENT_SPAWN_LINEAGE_ERROR, AGENT_SPAWN_LIVE_CHILD_CAP, agentSpawnLineageError, authenticatedAgentSpawnCaller, isAgentInitiatedSpawn } from "./admission";
import { spawnAccountErrorResponse } from "./accountError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGEST_SCAN_LIMIT = 80;
const SUGGEST_MAX = 10;

interface SuggestResponse {
  dirs: string[];
  /** Working directory of the `src` transcript when one was requested. */
  cwd: string | null;
  /** Whether the recorded source directory currently exists. */
  cwdExists: boolean;
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
  return NextResponse.json({ dirs, cwd: srcCwd, cwdExists });
}

export async function POST(req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { engine?: unknown; model?: unknown; cwd?: unknown; prompt?: unknown; images?: unknown; src?: unknown; parent?: unknown; parentConversationId?: unknown; effort?: unknown; fast?: unknown; accountId?: unknown; clientAttemptId?: unknown; role?: unknown; roleParams?: unknown; confirm?: unknown; reviews?: unknown; allowSubagents?: unknown };
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
  if (agentInitiated && body.allowSubagents === true) {
    return NextResponse.json({ error: "allowSubagents requires an authenticated Viewer operator spawn" }, { status: 403 });
  }

  const registry = agentRegistry();
  const authenticatedCaller = agentInitiated
    ? authenticatedAgentSpawnCaller(req, body.src, registry)
    : null;
  if (authenticatedCaller && "error" in authenticatedCaller) {
    return NextResponse.json({ error: authenticatedCaller.error }, { status: 403 });
  }
  const authenticatedCallerId = authenticatedCaller?.conversationId ?? null;

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

  const userPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const prompt = role.value ? [role.value.scaffold, userPrompt].filter(Boolean).join("\n\n") : userPrompt;
  const { images, error: imageError } = collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }

  /* Saved paths stay visible to the catch. A pane-bound receipt keeps them:
     the agent may already have accepted the prompt despite a later failure. */
  let imagePaths: string[] = [];
  let launchId: string | null = null;
  try {
    const account = await resolveHealthySpawnAccount(engine, body.accountId);
    const lineage = resolveSpawnLineage(agentInitiated
      ? { parentConversationId: authenticatedCallerId!, role: role.value?.role, reviews: body.reviews }
      : body, registry);
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
      parent: spawnParentSelector({ parentConversationId: parentConversationId ?? undefined }),
      ...(reviewedConversationId ? { reviews: spawnParentSelector({ parentConversationId: reviewedConversationId }) } : {}),
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
    const spec = { ...specBase, launchProfile: emptyLaunchProfile({ ...(specBase.launchProfile ?? {}), cwd, parentConversationId, allowSubagents: body.allowSubagents === true }) };
    const begun = registry.beginSpawnRequest({
      engine,
      cwd,
      accountId: account.accountId,
      parentConversationId,
      parentSessionKey,
      parentArtifactPath,
      role: role.value?.role ?? null,
      reviewsConversationId: reviewedConversationId,
      liveChildrenCap: agentInitiated ? AGENT_SPAWN_LIVE_CHILD_CAP : undefined,
      launchProfile: spec.launchProfile,
      clientAttemptId: body.clientAttemptId ?? null,
      requestDigest: digest,
    });
    if (begun.kind === "conflict") return NextResponse.json({ error: "spawn attempt conflicts with its original request" }, { status: 409 });
    if (begun.kind === "replay") {
      const response = spawnResponseForReceipt(begun.receipt);
      if (begun.receipt.state === "failed") return NextResponse.json({ error: "original spawn failed before launch", retrySafe: true }, { status: 409 });
      return NextResponse.json(response, { status: response.state === "starting" ? 202 : 200 });
    }
    launchId = begun.receipt.launchId;
    if (engine === "claude") {
      const profileId = path.basename(spec.transcript ?? "", ".jsonl");
      if (isManagedClaudeHome(account.home)) prepareManagedClaudeSpawnHome(account.home, cwd);
      applyClaudeSpawnPolicy(account.home, {
        allowSubagents: body.allowSubagents === true,
        baseSettingsPath: isManagedClaudeHome(account.home) ? claudeSettingsPath() : null,
        profileId,
      });
    }
    /* Pasted images land in the inbox and reach the fresh agent as file paths
       appended to its first prompt — the same contract the pane composer uses. */
    const bundle = buildImagePayload(prompt, images);
    imagePaths = bundle.imagePaths;
    let runtimeClient = runtimeEventsEnabled() ? runtimeHostClient() : null;
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
