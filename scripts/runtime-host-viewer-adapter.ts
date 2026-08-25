#!/usr/bin/env bun-container

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ViewerHealthEvidence,
  ViewerMcpRuntimeIdentity,
  ViewerMcpRuntimePublicationEvidence,
  ViewerMcpRuntimeReconciliation,
  ViewerReleaseIdentity,
} from "../src/lib/runtime/contracts";
import { admittedMcpHealthProbe } from "../src/lib/mcp/healthProbeAdmission";
import {
  acknowledgeHotStateFence,
  HOT_STATE_BACKEND,
  HOT_STATE_RELEASE_REVISION_ENV,
  publishHotStateAuthority,
  readHotStateAuthority,
  restoreHotStateAuthority,
  type HotStateAuthority,
} from "../src/lib/state/hotStateAuthority";
import {
  obsoleteManagedViewerContainers,
  viewerAuthenticationTokenFromConfig,
  viewerCandidateDockerArgs,
  viewerCandidateTmuxEnvironment,
  viewerComposeSnapshotWithoutWakatimeCredential,
  viewerComposeServiceFromConfig,
  viewerComposeServiceUid,
  viewerRegistryBackendMode,
} from "../src/runtime-host/candidateContainer";
import { ensureCanonicalMirror, resolveCanonicalRevision } from "../src/runtime-host/canonicalMirror";
import { allocateBuiltCandidatePort, candidatePortsFromEnvironmentLists, isCandidatePortAvailable } from "../src/runtime-host/candidatePort";
import { withBootstrapMcpHealthProbeAdmission } from "../src/runtime-host/bootstrapMcpHealthProbeAdmission";
import { viewerCandidateContainerName, viewerCandidateImageName, viewerComposeSnapshotName } from "../src/runtime-host/deploymentArtifacts";
import { bootstrapViewerRelease } from "../src/runtime-host/deploymentBootstrap";
import { McpHealthProbeAdmissions } from "../src/runtime-host/mcpHealthProbeAdmission";
import type { McpHealthProbeAdmissionConsumer } from "../src/runtime-host/mcpHealthProbeAdmissionChannel";
import { probeMcpRuntime } from "../src/runtime-host/mcpRuntimeProbe";
import { McpRuntimeReleaseStore } from "../src/runtime-host/mcpRuntimeRelease";
import {
  clearRuntimeHostHandoffIntent,
  readRuntimeHostHandoffIntent,
  readRuntimeHostRelease,
  runtimeHostHandoffIntentFile,
  runtimeHostReleaseFile,
  writeRuntimeHostHandoffIntent,
  writeRuntimeHostRelease,
} from "../src/runtime-host/hostRelease";
import { completeRuntimeHostHandoff, stageRuntimeHostSuccessorContainer } from "../src/runtime-host/hostSuccessor";
import {
  hasViewerDeploymentCapability,
  promotedViewerReadinessPhase,
  viewerDeploymentRegistryBackendMode,
  viewerDeploymentReleaseReady,
  viewerDeploymentStructuredHostStartup,
  viewerHealthRequestPlan,
  waitForViewerReadiness,
  type ViewerCandidateContainerState,
} from "../src/runtime-host/deploymentHealth";
import { withoutWakatimeCredential } from "../src/lib/wakatime/credential";

const defaultConfigDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "/home/user", ".config");
const stateDir = process.env.LLV_STATE_DIR || path.join(defaultConfigDir, "agent-log-viewer", "state");
const deploymentDir = path.join(stateDir, "deployments");
const mirrorDir = path.join(deploymentDir, "canonical.git");
const targetFile = process.env.LLV_VIEWER_DEPLOY_TARGET || path.join(stateDir, "viewer-release.json");
const canonicalRemote = process.env.LLV_VIEWER_CANONICAL_REMOTE || "https://github.com/Latand/live-log-viewer-next.git";
const runtimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET || path.join(stateDir, "runtime-host.sock");
const stableEndpoint = `http://127.0.0.1:${Number(process.env.LLV_VIEWER_PORT || 8898)}`;
const runtimeHostImageTag = process.env.LLV_RUNTIME_HOST_IMAGE_TAG || "agent-log-viewer:node22";
const mcpRuntimeRoot = process.env.LLV_MCP_RUNTIME_ROOT || path.join(process.env.HOME || "/home/user", ".agents", "tools", "llv-mcp-runtime");
const mcpRuntimeStore = new McpRuntimeReleaseStore({ stateDir, stableRuntimeRoot: mcpRuntimeRoot });
const deploymentPackageRoot = process.env.LLV_DEPLOYMENT_PACKAGE_ROOT || path.resolve(import.meta.dir, "..");
const releaseSwitchIntentFile = path.join(stateDir, "viewer-release-switch-intent.json");
const adapterPhaseFile = process.env.LLV_DEPLOYMENT_ADAPTER_PHASE_FILE?.trim() || null;

function writeDurableJson(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function removeDurableFile(filename: string): void {
  fs.rmSync(filename, { force: true });
  let directory: number;
  try { directory = fs.openSync(path.dirname(filename), "r"); }
  catch { return; }
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function reportAdapterPhase(action: string, phase: string): void {
  if (!adapterPhaseFile) return;
  writeDurableJson(adapterPhaseFile, { action, phase, updatedAt: new Date().toISOString() });
}

async function command(argv: string[], options: { cwd?: string } = {}): Promise<string> {
  const child = Bun.spawn(["/usr/bin/setpriv", "--pdeathsig", "KILL", "--", ...argv], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: withoutWakatimeCredential(process.env),
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error((stderr.trim() || `${argv[0]} failed`).slice(0, 1000));
  return stdout.trim();
}

async function ensureMirror(): Promise<void> {
  await ensureCanonicalMirror(
    { deploymentDir, mirrorDir, remote: canonicalRemote },
    { run: command },
  );
}

async function resolveRevision(requested: string): Promise<string> {
  return resolveCanonicalRevision(requested, { mirrorDir, remote: canonicalRemote }, { run: command, ensureMirror });
}

function composeConfigFile(container: string): string {
  return path.join(deploymentDir, "compose", viewerComposeSnapshotName(container));
}

function writeComposeConfig(container: string, config: string): void {
  const snapshot = viewerComposeSnapshotWithoutWakatimeCredential(config);
  viewerComposeServiceFromConfig(snapshot);
  const filename = composeConfigFile(container);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, snapshot, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filename);
}

async function managedCandidatePorts(): Promise<Set<number>> {
  const output = await command(["docker", "container", "ls", "-a", "--filter", "label=dev.live-log-viewer.managed=1", "--format", "{{.ID}}"]);
  const environments: string[][] = [];
  for (const id of output.split("\n").map((item) => item.trim()).filter(Boolean)) {
    try {
      const value = JSON.parse(await command(["docker", "container", "inspect", "--format", "{{json .Config.Env}}", id])) as unknown;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("managed Viewer environment is invalid");
      environments.push(value as string[]);
    } catch (error) {
      if (error instanceof Error && (error.message.includes("No such container") || error.message.includes("No such object"))) continue;
      throw error;
    }
  }
  return candidatePortsFromEnvironmentLists(environments);
}

function release(value: unknown): ViewerReleaseIdentity {
  if (!value || typeof value !== "object") throw new Error("release identity is invalid");
  const item = value as Partial<ViewerReleaseIdentity>;
  if (typeof item.image !== "string" || typeof item.container !== "string" || typeof item.endpoint !== "string" || typeof item.revision !== "string") {
    throw new Error("release identity is invalid");
  }
  return {
    image: item.image,
    container: item.container,
    endpoint: item.endpoint,
    revision: item.revision,
    ...(item.hotStateBackend === HOT_STATE_BACKEND ? { hotStateBackend: item.hotStateBackend } : {}),
    ...(item.mcpRuntime === undefined ? {} : { mcpRuntime: mcpRuntime(item.mcpRuntime) }),
  };
}

function mcpRuntime(value: unknown): ViewerMcpRuntimeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP runtime identity is invalid");
  const runtime = value as Partial<ViewerMcpRuntimeIdentity>;
  if ((runtime.source !== "legacy" && runtime.source !== "managed")
    || typeof runtime.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(runtime.revision)
    || typeof runtime.artifactDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(runtime.artifactDigest)
    || (runtime.source === "managed" && (typeof runtime.releaseId !== "string" || !/^[a-z0-9-]+$/.test(runtime.releaseId)))
    || (runtime.source === "legacy" && runtime.releaseId !== null)
    || (runtime.source === "managed" && typeof runtime.stagedAt !== "string")
    || (runtime.source === "legacy" && runtime.stagedAt !== null)) {
    throw new Error("MCP runtime identity is invalid");
  }
  return runtime as ViewerMcpRuntimeIdentity;
}

function runtimeHostGeneration(value: unknown): { image: string; revision: string; container: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime-host generation is invalid");
  const generation = value as Record<string, unknown>;
  if (typeof generation.image !== "string" || typeof generation.revision !== "string" || typeof generation.container !== "string") {
    throw new Error("runtime-host generation is invalid");
  }
  return { image: generation.image, revision: generation.revision, container: generation.container };
}

async function buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
  const runtimeHome = process.env.HOME?.trim();
  if (!runtimeHome || !path.isAbsolute(runtimeHome)) {
    throw new Error("runtime-host HOME must be an absolute path before building a Viewer candidate");
  }
  await ensureMirror();
  await command(["git", "--git-dir", mirrorDir, "cat-file", "-e", `${revision}^{commit}`]);
  const sourceDir = path.join(deploymentDir, deploymentId, "source");
  fs.rmSync(path.dirname(sourceDir), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true, mode: 0o700 });
  await command(["git", "--git-dir", mirrorDir, "worktree", "prune"]);
  await command(["git", "--git-dir", mirrorDir, "worktree", "add", "--detach", sourceDir, revision]);
  const container = viewerCandidateContainerName(deploymentId);
  const image = viewerCandidateImageName(revision, container);
  const hotStateBackend = fs.existsSync(path.join(sourceDir, "src", "lib", "state", "hotStateAuthority.ts"))
    ? HOT_STATE_BACKEND
    : undefined;
  let mcpRuntime: ViewerMcpRuntimeIdentity | null = null;
  try {
    const composeConfig = await command([
      "docker", "compose", "--project-directory", sourceDir, "-f", path.join(sourceDir, "docker-compose.yml"),
      "--profile", "*", "config", "--format", "json",
    ]);
    writeComposeConfig(container, composeConfig);
    await command([
      "docker", "build", "--pull",
      "--build-arg", `LLV_RUNTIME_HOME=${runtimeHome}`,
      "--label", `dev.live-log-viewer.revision=${revision}`,
      "-t", image, sourceDir,
    ]);
    await command([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: sourceDir });
    await command([process.execPath, "run", "build:mcp"], { cwd: sourceDir });
    mcpRuntime = mcpRuntimeStore.stagePreparedPackage(sourceDir, deploymentId, revision);
    mcpRuntimeStore.installStableLauncher(deploymentPackageRoot);
  } catch (error) {
    if (mcpRuntime) mcpRuntimeStore.retire(mcpRuntime);
    try { await command(["docker", "image", "rm", image]); } catch { /* image construction may have failed */ }
    fs.rmSync(composeConfigFile(container), { force: true });
    throw error;
  } finally {
    try { await command(["git", "--git-dir", mirrorDir, "worktree", "remove", "--force", sourceDir]); }
    catch { fs.rmSync(sourceDir, { recursive: true, force: true }); }
  }
  try {
    const port = await allocateBuiltCandidatePort(deploymentId, {
      base: Number(process.env.LLV_VIEWER_CANDIDATE_PORT_BASE || 18_000),
      slots: 2_000,
      reservedPorts: managedCandidatePorts,
      isAvailable: isCandidatePortAvailable,
      removeImage: async () => { await command(["docker", "image", "rm", image]); },
      removeComposeSnapshot: () => { fs.rmSync(composeConfigFile(container), { force: true }); },
    });
    if (!mcpRuntime) throw new Error("candidate MCP runtime staging did not complete");
    return {
      revision,
      image,
      container,
      endpoint: `http://127.0.0.1:${port}`,
      ...(hotStateBackend ? { hotStateBackend } : {}),
      mcpRuntime,
    };
  } catch (error) {
    if (mcpRuntime) mcpRuntimeStore.retire(mcpRuntime);
    throw error;
  }
}

async function containerExists(container: string): Promise<boolean> {
  try { await command(["docker", "container", "inspect", container]); return true; }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("No such container") || message.includes("No such object")) return false;
    throw error;
  }
}

async function startCandidate(candidate: ViewerReleaseIdentity): Promise<void> {
  const port = Number(new URL(candidate.endpoint).port);
  if (await containerExists(candidate.container)) {
    const state = await command(["docker", "inspect", "--format", "{{.State.Status}}", candidate.container]);
    if (state !== "running" && !await isCandidatePortAvailable(port)) throw new Error("candidate Viewer port is unavailable before restart");
    await command(["docker", "start", candidate.container]);
    return;
  }
  if (!await isCandidatePortAvailable(port)) throw new Error("candidate Viewer port is unavailable before start");
  const composeService = viewerComposeServiceFromConfig(fs.readFileSync(composeConfigFile(candidate.container), "utf8"));
  const uid = viewerComposeServiceUid(composeService);
  const tmuxEnvironment = viewerCandidateTmuxEnvironment(stateDir, uid, {
    legacyTmuxExternal: composeService.environment.LLV_LEGACY_TMUX_EXTERNAL || "0",
    tmuxTmpdir: composeService.environment.TMUX_TMPDIR || "/tmp",
  });
  await command(viewerCandidateDockerArgs(candidate, composeService, {
    runtimeSocket,
    ...tmuxEnvironment,
  }));
}

async function retireRelease(candidate: ViewerReleaseIdentity): Promise<void> {
  if (await containerExists(candidate.container)) await command(["docker", "container", "rm", "-f", candidate.container]);
  try { await command(["docker", "image", "rm", candidate.image]); } catch { /* another retained release may use this image */ }
  fs.rmSync(composeConfigFile(candidate.container), { force: true });
  if (candidate.mcpRuntime) mcpRuntimeStore.retire(candidate.mcpRuntime);
}

async function retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> {
  if (releases.length === 0) throw new Error("at least one retained release is required");
  const output = await command(["docker", "container", "ls", "-a", "--filter", "label=dev.live-log-viewer.managed=1", "--format", "{{.Names}}"]);
  const containers = output.split("\n").map((item) => item.trim()).filter(Boolean);
  const retainedImages = new Set(releases.map((item) => item.image));
  for (const container of obsoleteManagedViewerContainers(containers, releases.map((item) => item.container))) {
    const image = await command(["docker", "container", "inspect", "--format", "{{.Config.Image}}", container]);
    await command(["docker", "container", "rm", "-f", container]);
    fs.rmSync(composeConfigFile(container), { force: true });
    if (image && !retainedImages.has(image)) {
      try { await command(["docker", "image", "rm", image]); } catch { /* another container may use this image */ }
    }
  }
  /* The first release serves stable traffic. Later entries are durable rollback
     slots: keep their container, image, config and reserved port while freeing
     the application process and its scanner caches. */
  for (const rollback of releases.slice(1)) {
    if (await containerExists(rollback.container)) {
      await command(["docker", "container", "stop", "--time", "10", rollback.container]);
    }
  }
  mcpRuntimeStore.retainOnly(releases.flatMap((item) => item.mcpRuntime ? [item.mcpRuntime] : []));
}

function serviceToken(candidate: ViewerReleaseIdentity): string | null {
  return viewerAuthenticationTokenFromConfig(fs.readFileSync(composeConfigFile(candidate.container), "utf8"));
}

async function fetchStatus(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(url, { headers: { connection: "close", ...headers }, redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return { status: response.status, text: await response.text() };
  } catch {
    return { status: 0, text: "" };
  }
}

function referencedAssets(html: string): string[] {
  const assets = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const asset = match[1];
    if (asset?.startsWith("/_next/") && /\.(?:css|js)(?:\?|$)/.test(asset)) assets.add(asset);
  }
  return [...assets].sort();
}

async function containerState(container: string): Promise<ViewerCandidateContainerState> {
  if (!await containerExists(container)) return "missing";
  return await command(["docker", "inspect", "--format", "{{.State.Status}}", container]) === "running" ? "running" : "exited";
}

async function probeRoutes(
  candidate: ViewerReleaseIdentity,
  endpoint: string,
  expectedAssetsEndpoint?: string,
  reportPhase?: (phase: string) => void,
): Promise<ViewerHealthEvidence> {
  const token = serviceToken(candidate);
  const requests = viewerHealthRequestPlan(endpoint, token);
  const root = await fetchStatus(requests.root.url, requests.root.headers);
  const authenticated = requests.authenticated ? await fetchStatus(requests.authenticated.url, requests.authenticated.headers) : null;
  const unauthorized = requests.unauthorized ? await fetchStatus(requests.unauthorized.url, requests.unauthorized.headers) : null;
  const capability = await fetchStatus(requests.capability.url, requests.capability.headers);
  const deploymentCapable = hasViewerDeploymentCapability(capability.status, capability.text);
  const expectedRegistryBackendMode = viewerRegistryBackendMode(
    viewerComposeServiceFromConfig(fs.readFileSync(composeConfigFile(candidate.container), "utf8")),
  );
  const observedRegistryBackendMode = viewerDeploymentRegistryBackendMode(capability.status, capability.text);
  const registryBackendMatches = observedRegistryBackendMode === expectedRegistryBackendMode;
  const releaseReady = expectedAssetsEndpoint === undefined
    || viewerDeploymentReleaseReady(capability.status, capability.text);
  if (expectedAssetsEndpoint !== undefined) {
    reportPhase?.(promotedViewerReadinessPhase(
      viewerDeploymentStructuredHostStartup(capability.status, capability.text),
    ));
  }
  const html = authenticated?.status === 200 ? authenticated.text : root.text;
  const paths = referencedAssets(html);
  const assets = await Promise.all(paths.map(async (asset) => ({ path: asset, status: (await fetchStatus(`${endpoint}${asset}`)).status })));
  let expectedAssetsMatch = true;
  if (expectedAssetsEndpoint) {
    const expectedRequests = viewerHealthRequestPlan(expectedAssetsEndpoint, token);
    const expectedRequest = expectedRequests.authenticated ?? expectedRequests.root;
    const expectedRoot = await fetchStatus(expectedRequest.url, expectedRequest.headers);
    expectedAssetsMatch = JSON.stringify(referencedAssets(expectedRoot.text)) === JSON.stringify(paths);
  }
  const processReady = true;
  const ok = root.status === 200
    && (authenticated === null || authenticated.status === 200)
    && (unauthorized === null || unauthorized.status === 403)
    && assets.length > 0
    && assets.every((asset) => asset.status === 200)
    && deploymentCapable
    && registryBackendMatches
    && releaseReady
    && expectedAssetsMatch;
  return {
    checkedAt: new Date().toISOString(), endpoint, processReady, rootStatus: root.status,
    authenticatedStatus: authenticated?.status ?? null, unauthorizedStatus: unauthorized?.status ?? null, assets, ok,
    ...(ok ? {} : {
      detail: !deploymentCapable
        ? "Viewer deployment capability gate failed"
        : !registryBackendMatches
          ? `Viewer registry backend mode mismatch: expected ${expectedRegistryBackendMode}, observed ${observedRegistryBackendMode ?? "unavailable"}`
          : !releaseReady
            ? "Viewer release startup is incomplete"
            : expectedAssetsMatch
              ? "Viewer health or referenced asset gate failed"
              : "stable listener does not serve the candidate asset set",
    }),
  };
}

async function verifyViewer(
  candidate: ViewerReleaseIdentity,
  endpoint: string,
  expectedAssetsEndpoint?: string,
  reportPhase?: (phase: string) => void,
): Promise<ViewerHealthEvidence> {
  return waitForViewerReadiness({
    endpoint,
    inspect: () => containerState(candidate.container),
    probe: () => probeRoutes(candidate, endpoint, expectedAssetsEndpoint, reportPhase),
    ...(expectedAssetsEndpoint ? { maxAttempts: 90 } : {}),
  });
}

export function mcpProbeEnvironment(
  endpoint: string,
  deployTarget: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(withoutWakatimeCredential(env))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    LLV_VIEWER_DEPLOY_TARGET: deployTarget,
    // Candidate health must exercise the candidate's web/runtime client. The
    // stable listener still serves the previous generation before promotion.
    LLV_VIEWER_CONTROL_URL: endpoint,
  };
}

async function verify(
  candidate: ViewerReleaseIdentity,
  endpoint: string,
  options: {
    expectedAssetsEndpoint?: string;
    healthProbeCapability?: string;
    healthProbeAdmissions?: McpHealthProbeAdmissionConsumer;
    reportPhase?: (phase: string) => void;
  } = {},
): Promise<ViewerHealthEvidence> {
  const viewer = await verifyViewer(candidate, endpoint, options.expectedAssetsEndpoint, options.reportPhase);
  if (!viewer.ok) return viewer;
  if (!candidate.mcpRuntime || candidate.mcpRuntime.source !== "managed") {
    return { ...viewer, ok: false, detail: "candidate MCP runtime identity is missing" };
  }
  const promoted = options.expectedAssetsEndpoint !== undefined;
  const probeTarget = promoted
    ? targetFile
    : path.join(stateDir, `mcp-candidate-probe-${candidate.mcpRuntime.releaseId}.json`);
  if (!promoted) writeReleaseTarget(probeTarget, candidate);
  const probeEnvironment = mcpProbeEnvironment(endpoint, probeTarget);
  const mcpRuntime = await probeMcpRuntime({
    command: process.execPath,
    args: [path.join(mcpRuntimeRoot, "bin", "mcp-server.mjs")],
    cwd: mcpRuntimeRoot,
    env: probeEnvironment,
    runtime: candidate.mcpRuntime,
    ...(options.healthProbeCapability ? { healthProbeCapability: options.healthProbeCapability } : {}),
    ...(options.healthProbeAdmissions ? { healthProbeAdmissions: options.healthProbeAdmissions } : {}),
  });
  if (!promoted) {
    fs.rmSync(probeTarget, { force: true });
    const state = fs.openSync(stateDir, "r");
    try { fs.fsyncSync(state); } finally { fs.closeSync(state); }
  }
  return {
    ...viewer,
    mcpRuntime,
    ok: mcpRuntime.ok,
    ...(mcpRuntime.ok ? {} : { detail: mcpRuntime.detail ?? "MCP runtime health gate failed" }),
  };
}

function readTarget(): ViewerReleaseIdentity {
  return release(JSON.parse(fs.readFileSync(targetFile, "utf8")));
}

function releasesEqual(left: ViewerReleaseIdentity, right: ViewerReleaseIdentity): boolean {
  return left.image === right.image
    && left.container === right.container
    && left.endpoint === right.endpoint
    && left.revision === right.revision;
}

function readCurrentRelease(): ViewerReleaseIdentity | null {
  let raw: string;
  try {
    raw = fs.readFileSync(targetFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("current release target is unreadable", { cause: error });
  }
  try {
    return release(JSON.parse(raw));
  } catch (error) {
    throw new Error("current release target is invalid", { cause: error });
  }
}

interface ViewerReleaseSwitchIntent {
  schemaVersion: 1;
  action: "activate" | "restore";
  previousTarget: ViewerReleaseIdentity | null;
  previousAuthority: HotStateAuthority | null;
  target: ViewerReleaseIdentity;
  recordedAt: string;
}

function checkpointFromIntent(value: unknown): HotStateAuthority["checkpoint"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Viewer release switch intent is invalid");
  const checkpoint = value as { acknowledgedAt?: unknown; revisions?: Record<string, unknown> };
  const revisions = checkpoint.revisions;
  const numbers = revisions
    ? [revisions.flows, revisions.pipelines, revisions.pipelinesArchive, revisions.workflows]
    : [];
  if (typeof checkpoint.acknowledgedAt !== "string"
    || numbers.length !== 4
    || numbers.some((revision) => !Number.isInteger(revision) || (revision as number) < 0)) {
    throw new Error("Viewer release switch intent is invalid");
  }
  return value as HotStateAuthority["checkpoint"];
}

function authorityFromIntent(value: unknown): HotStateAuthority | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Viewer release switch intent is invalid");
  const authority = value as Partial<HotStateAuthority>;
  if (authority.schemaVersion !== 1
    || !Number.isInteger(authority.epoch)
    || (authority.epoch ?? 0) < 1
    || !["legacy", "preparing", "sqlite", "fencing"].includes(String(authority.mode))
    || (authority.releaseRevision !== null
      && (typeof authority.releaseRevision !== "string" || !/^[0-9a-f]{40}$/.test(authority.releaseRevision)))
    || typeof authority.updatedAt !== "string"
    || (authority.activationReadyAt !== undefined && typeof authority.activationReadyAt !== "string")
    || (authority.releaseReadyAt !== undefined && typeof authority.releaseReadyAt !== "string")
    || (authority.releaseReadyAt !== undefined && authority.activationReadyAt === undefined)) {
    throw new Error("Viewer release switch intent is invalid");
  }
  return {
    ...(authority as HotStateAuthority),
    ...(checkpointFromIntent(authority.checkpoint) ? { checkpoint: checkpointFromIntent(authority.checkpoint) } : {}),
  };
}

function readReleaseSwitchIntent(): ViewerReleaseSwitchIntent | null {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(releaseSwitchIntentFile, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Viewer release switch intent is unreadable", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Viewer release switch intent is invalid");
  const intent = value as Record<string, unknown>;
  if (intent.schemaVersion !== 1
    || (intent.action !== "activate" && intent.action !== "restore")
    || typeof intent.recordedAt !== "string") throw new Error("Viewer release switch intent is invalid");
  return {
    schemaVersion: 1,
    action: intent.action,
    previousTarget: intent.previousTarget === null ? null : release(intent.previousTarget),
    previousAuthority: authorityFromIntent(intent.previousAuthority),
    target: release(intent.target),
    recordedAt: intent.recordedAt,
  };
}

function sameAuthority(left: HotStateAuthority | null, right: HotStateAuthority | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetMatches(left: ViewerReleaseIdentity | null, right: ViewerReleaseIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return releasesEqual(left, right);
}

function expectedTransitionAuthority(intent: ViewerReleaseSwitchIntent, authority: HotStateAuthority | null): boolean {
  if (!authority) return false;
  const expectedMode = intent.action === "restore"
    ? intent.target.hotStateBackend === HOT_STATE_BACKEND ? "sqlite" : "legacy"
    : intent.target.hotStateBackend === HOT_STATE_BACKEND
      ? intent.previousAuthority?.mode === "sqlite" ? "sqlite" : "preparing"
      : "legacy";
  return authority.epoch === (intent.previousAuthority?.epoch ?? 0) + 1
    && authority.mode === expectedMode
    && authority.releaseRevision === intent.target.revision;
}

function authorityServesTarget(authority: HotStateAuthority | null, target: ViewerReleaseIdentity): boolean {
  return authority?.releaseRevision === target.revision
    && (target.hotStateBackend === HOT_STATE_BACKEND
      ? authority.mode === "preparing" || authority.mode === "sqlite"
      : authority.mode === "legacy");
}

function recoverInterruptedReleaseSwitch(): void {
  const intent = readReleaseSwitchIntent();
  if (!intent) return;
  const currentTarget = readCurrentRelease();
  const currentAuthority = readHotStateAuthority(stateDir);
  if (targetMatches(currentTarget, intent.target)) {
    if (!authorityServesTarget(currentAuthority, intent.target)) {
      throw new Error("interrupted Viewer release switch target has mismatched hot-state authority");
    }
    removeDurableFile(releaseSwitchIntentFile);
    return;
  }
  if (!targetMatches(currentTarget, intent.previousTarget)) {
    throw new Error("interrupted Viewer release switch conflicts with the durable target");
  }
  if (sameAuthority(currentAuthority, intent.previousAuthority)) {
    removeDurableFile(releaseSwitchIntentFile);
    return;
  }
  if (!expectedTransitionAuthority(intent, currentAuthority)) {
    throw new Error("interrupted Viewer release switch has unexpected hot-state authority");
  }
  const restored = restoreHotStateAuthority(stateDir, intent.previousAuthority, currentAuthority!);
  if (!restored) throw new Error("interrupted Viewer release switch authority changed during recovery");
  removeDurableFile(releaseSwitchIntentFile);
}

function writeReleaseTarget(filename: string, target: ViewerReleaseIdentity): void {
  mcpRuntimeStore.publishReleaseTarget(filename, target);
}

function removeReleaseTarget(filename: string): void {
  try { fs.unlinkSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function switchTarget(
  target: ViewerReleaseIdentity,
  action: ViewerMcpRuntimePublicationEvidence["action"],
  fallbackRuntime?: ViewerMcpRuntimeIdentity,
  fence?: HotStateAuthority | null,
  phase?: (value: string) => void,
): ViewerMcpRuntimePublicationEvidence {
  const runtime = target.mcpRuntime ?? fallbackRuntime;
  if (!runtime) throw new Error("release MCP runtime identity is missing");
  if (runtime.source === "managed" && runtime.revision !== target.revision) {
    throw new Error("release MCP runtime revision does not match the Viewer revision");
  }
  const currentTarget = readCurrentRelease();
  const sameRelease = currentTarget?.revision === target.revision
    && currentTarget.endpoint === target.endpoint;
  const previousAuthority = readHotStateAuthority(stateDir);
  let transitionAuthority: HotStateAuthority | null = null;
  const intent: ViewerReleaseSwitchIntent | null = sameRelease
    ? null
    : {
        schemaVersion: 1,
        action,
        previousTarget: currentTarget,
        previousAuthority,
        target,
        recordedAt: new Date().toISOString(),
      };
  if (intent) {
    phase?.("recording the Viewer release switch intent");
    writeDurableJson(releaseSwitchIntentFile, intent);
  }
  try {
    if (!sameRelease) {
      phase?.("publishing hot-state authority");
      if (action === "restore") {
        transitionAuthority = publishHotStateAuthority(
          stateDir,
          target.hotStateBackend === HOT_STATE_BACKEND ? "sqlite" : "legacy",
          target.revision,
          fence?.checkpoint ? { checkpoint: fence.checkpoint } : {},
        );
      } else if (target.hotStateBackend === HOT_STATE_BACKEND && previousAuthority?.mode !== "sqlite") {
        transitionAuthority = publishHotStateAuthority(stateDir, "preparing", target.revision);
      } else if (target.hotStateBackend === HOT_STATE_BACKEND) {
        transitionAuthority = publishHotStateAuthority(stateDir, "sqlite", target.revision);
      } else if (target.hotStateBackend !== HOT_STATE_BACKEND) {
        transitionAuthority = publishHotStateAuthority(
          stateDir,
          "legacy",
          target.revision,
          fence?.checkpoint ? { checkpoint: fence.checkpoint } : {},
        );
      }
    }
    if (transitionAuthority
      && process.env.NODE_ENV === "test"
      && process.env.LLV_TEST_EXIT_AFTER_HOT_STATE_AUTHORITY === "1") process.exit(86);
    phase?.("publishing the Viewer release target");
    writeReleaseTarget(targetFile, target);
    if (intent) removeDurableFile(releaseSwitchIntentFile);
  } catch (error) {
    let restoreError: unknown = null;
    try {
      if (currentTarget) writeReleaseTarget(targetFile, currentTarget);
      else removeReleaseTarget(targetFile);
    } catch (failure) {
      restoreError = failure;
    }
    try {
      if (transitionAuthority) {
        const restored = restoreHotStateAuthority(stateDir, previousAuthority, transitionAuthority);
        if (!restored) throw new Error("hot-state authority changed before target restore");
      }
    } catch (failure) {
      restoreError ??= failure;
    }
    if (!restoreError && intent) {
      try { removeDurableFile(releaseSwitchIntentFile); }
      catch (failure) { restoreError = failure; }
    }
    if (restoreError) {
      const message = error instanceof Error ? error.message : "release target publication failed";
      const restoreMessage = restoreError instanceof Error ? restoreError.message : "handoff restore failed";
      throw new Error(`${message}; restore failed: ${restoreMessage}`);
    }
    throw error;
  }
  return {
    action,
    ...runtime,
    publishedAt: new Date().toISOString(),
    durable: true,
  };
}

function authorityMatchesRelease(authority: HotStateAuthority | null, target: ViewerReleaseIdentity): boolean {
  return authority?.releaseRevision === target.revision
    && (target.hotStateBackend === HOT_STATE_BACKEND ? authority.mode === "sqlite" : authority.mode === "legacy");
}

async function checkpointHotStateFence(
  request: HotStateAuthority,
  revision: string,
): Promise<HotStateAuthority> {
  const previousExplicitRevision = process.env[HOT_STATE_RELEASE_REVISION_ENV];
  process.env[HOT_STATE_RELEASE_REVISION_ENV] = revision;
  try {
    const { checkpointHotStateRollbackMirrorsForDemotion } = await import("../src/lib/viewerInstrumentation");
    const revisions = await checkpointHotStateRollbackMirrorsForDemotion();
    const { agentRegistry } = await import("../src/lib/agent/registry");
    agentRegistry().checkpointRollbackMirrorForDemotion();
    const current = readHotStateAuthority(stateDir);
    if (current?.mode === "fencing"
      && current.epoch === request.epoch
      && current.releaseRevision === revision
      && current.checkpoint) return current;
    try {
      return acknowledgeHotStateFence(stateDir, request, revisions);
    } catch (error) {
      const acknowledged = readHotStateAuthority(stateDir);
      if (acknowledged?.mode === "fencing"
        && acknowledged.epoch === request.epoch
        && acknowledged.releaseRevision === revision
        && acknowledged.checkpoint) return acknowledged;
      throw error;
    }
  } finally {
    if (previousExplicitRevision === undefined) delete process.env[HOT_STATE_RELEASE_REVISION_ENV];
    else process.env[HOT_STATE_RELEASE_REVISION_ENV] = previousExplicitRevision;
  }
}

async function fenceCurrentSqliteRelease(
  revision: string,
  destination: ViewerReleaseIdentity,
): Promise<HotStateAuthority | null> {
  const previous = readHotStateAuthority(stateDir);
  if (authorityMatchesRelease(previous, destination)) return previous;
  if (previous?.mode !== "sqlite" && previous?.mode !== "fencing") return null;
  if (previous.releaseRevision !== revision) {
    throw new Error("active hot-state authority differs from the rollback source release");
  }
  const request = publishHotStateAuthority(stateDir, "fencing", revision);
  try {
    return await checkpointHotStateFence(request, revision);
  } catch (error) {
    restoreHotStateAuthority(stateDir, previous, request);
    throw error;
  }
}

async function waitForHotStateActivation(candidate: ViewerReleaseIdentity): Promise<void> {
  if (candidate.hotStateBackend !== HOT_STATE_BACKEND) return;
  const requestedTimeoutMs = Number(process.env.LLV_HOT_STATE_ACTIVATION_TIMEOUT_MS || 30_000);
  const requestedPollMs = Number(process.env.LLV_HOT_STATE_ACTIVATION_POLL_MS || 50);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(100, requestedTimeoutMs) : 30_000;
  const pollMs = Number.isFinite(requestedPollMs) ? Math.max(5, requestedPollMs) : 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const authority = readHotStateAuthority(stateDir);
    if (authority?.mode === "sqlite"
      && authority.releaseRevision === candidate.revision
      && authority.activationReadyAt) return;
    await Bun.sleep(pollMs);
  }
  throw new Error("timed out waiting for the promoted Viewer to activate hot state");
}

async function promoteTarget(
  candidate: ViewerReleaseIdentity,
  phase: (value: string) => void = () => {},
): Promise<ViewerMcpRuntimePublicationEvidence> {
  const current = readCurrentRelease();
  phase("fencing the current SQLite release");
  const fence = current?.hotStateBackend === HOT_STATE_BACKEND
    && candidate.hotStateBackend !== HOT_STATE_BACKEND
    ? await fenceCurrentSqliteRelease(current.revision, candidate)
    : null;
  const publication = switchTarget(candidate, "activate", undefined, fence, phase);
  phase("waiting for hot-state activation");
  await waitForHotStateActivation(candidate);
  return publication;
}

async function currentMcpRuntime(): Promise<ViewerMcpRuntimeIdentity> {
  const current = readCurrentRelease();
  if (current?.mcpRuntime) return current.mcpRuntime;
  const revision = await command(["git", "-C", mcpRuntimeRoot, "rev-parse", "HEAD"]);
  return mcpRuntimeStore.legacyRuntimeIdentity(revision);
}

/* #618 successor-boot reconcile. A deployment driven by an older adapter
   promotes the new Viewer without ever publishing a matching MCP runtime, so
   the successor generation is the first process that can repair it: it stages
   from its own package, installs the launcher, and gates on the full tool
   surface. `stagePreparedPackage` derives its release id from the deployment
   id, so a boot that crashed mid-reconcile reuses (never duplicates) the same
   release, and a boot that already matches does nothing at all. */
async function reconcileMcpRuntime(
  revision: string,
  healthProbe?: {
    healthProbeCapability: string;
    healthProbeAdmissions: McpHealthProbeAdmissionConsumer;
  },
): Promise<ViewerMcpRuntimeReconciliation | null> {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("runtime-host MCP revision is invalid");
  const previous = readTarget();
  if (previous.revision !== revision) throw new Error("runtime-host MCP revision differs from the active Viewer release");
  const published = previous.mcpRuntime;
  if (published?.source === "managed" && published.revision === revision) return null;
  const runtime = mcpRuntimeStore.stagePreparedPackage(deploymentPackageRoot, `runtime-host-bootstrap-${revision}`, revision);
  try {
    mcpRuntimeStore.installStableLauncher(deploymentPackageRoot);
    const publication = switchTarget({ ...previous, mcpRuntime: runtime }, "activate");
    const probeEnvironment = mcpProbeEnvironment(stableEndpoint, targetFile);
    const health = await probeMcpRuntime({
      command: process.execPath,
      args: [path.join(mcpRuntimeRoot, "bin", "mcp-server.mjs")],
      cwd: mcpRuntimeRoot,
      env: probeEnvironment,
      runtime,
      ...(healthProbe ?? {}),
    });
    if (!health.ok) throw new Error(health.detail ?? "runtime-host MCP reconciliation health gate failed");
    return { publication, health };
  } catch (error) {
    let restoreError: unknown = null;
    try { writeReleaseTarget(targetFile, previous); } catch (failure) { restoreError = failure; }
    try { mcpRuntimeStore.retire(runtime); } catch (failure) { restoreError ??= failure; }
    if (restoreError) {
      const message = error instanceof Error ? error.message : "runtime-host MCP reconciliation failed";
      const restoreMessage = restoreError instanceof Error ? restoreError.message : "MCP target restore failed";
      throw new Error(`${message}; restore failed: ${restoreMessage}`);
    }
    throw error;
  }
}

/** #518 runtime-host generation handoff (see hostSuccessor.ts for the
    ordering contract). Every mutation is a short-lived CLI call against the
    host Docker daemon, so the successor container exists daemon-side before
    the predecessor generation is allowed to exit; this adapter process never
    needs to survive that exit. Only the runtime-host generation changes —
    Viewer containers and the engine processes they own are never signalled. */
async function stageRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<void> {
  const registryBackendMode = viewerRegistryBackendMode(
    viewerComposeServiceFromConfig(fs.readFileSync(composeConfigFile(candidate.container), "utf8")),
  );
  await stageRuntimeHostSuccessorContainer(candidate, runtimeHostImageTag, {
    docker: (argv) => command(["docker", ...argv]),
    writeRelease: (record) => writeRuntimeHostRelease(record, runtimeHostReleaseFile()),
    readRelease: () => readRuntimeHostRelease(runtimeHostReleaseFile()),
    readHandoffIntent: () => readRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile()),
    writeHandoffIntent: (intent) => writeRuntimeHostHandoffIntent(intent, runtimeHostHandoffIntentFile()),
    clearHandoffIntent: () => clearRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile()),
    fenceOwnerPid: () => {
      try {
        const owner = JSON.parse(fs.readFileSync(`${runtimeSocket}.lock`, "utf8")) as { pid?: unknown };
        return Number.isInteger(owner.pid) && (owner.pid as number) > 0 ? owner.pid as number : null;
      } catch {
        return null;
      }
    },
  }, { registryBackendMode });
}

export interface BootstrapReleaseDependencies {
  runtimeSocket: string;
  targetExists(): boolean;
  resolveRevision(requested: string): Promise<string>;
  buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity>;
  startCandidate(candidate: ViewerReleaseIdentity): Promise<void>;
  verifyCandidate(
    candidate: ViewerReleaseIdentity,
    healthProbeCapability: string,
    healthProbeAdmissions: McpHealthProbeAdmissionConsumer,
  ): Promise<ViewerHealthEvidence>;
  publishTarget(candidate: ViewerReleaseIdentity): Promise<void>;
  targetMatches(candidate: ViewerReleaseIdentity): boolean;
  retireCandidate(candidate: ViewerReleaseIdentity): Promise<void>;
}

export async function runBootstrapRelease(
  input: Record<string, unknown>,
  dependencies: BootstrapReleaseDependencies = {
    runtimeSocket,
    targetExists: () => fs.existsSync(targetFile),
    resolveRevision,
    buildCandidate,
    startCandidate,
    verifyCandidate: (candidate, healthProbeCapability, healthProbeAdmissions) =>
      verify(candidate, candidate.endpoint, { healthProbeCapability, healthProbeAdmissions }),
    publishTarget: async (candidate) => {
      await promoteTarget(candidate);
    },
    targetMatches: (candidate) => releasesEqual(readTarget(), candidate),
    retireCandidate: retireRelease,
  },
) {
  return bootstrapViewerRelease(String(input.revision ?? "origin/main"), `bootstrap-${randomUUID()}`, {
    ...dependencies,
    verifyCandidate: (candidate) => withBootstrapMcpHealthProbeAdmission(
      dependencies.runtimeSocket,
      (healthProbeCapability, healthProbeAdmissions) =>
        dependencies.verifyCandidate(candidate, healthProbeCapability, healthProbeAdmissions),
    ),
  });
}

async function delegatedHealthProbeAdmission(
  hostCapability: string | undefined,
): Promise<{
  healthProbeCapability: string;
  healthProbeAdmissions: McpHealthProbeAdmissionConsumer;
} | undefined> {
  if (!await admittedMcpHealthProbe(hostCapability)) return undefined;
  const admissions = new McpHealthProbeAdmissions();
  return {
    healthProbeCapability: admissions.issue(),
    healthProbeAdmissions: admissions,
  };
}

async function main(): Promise<unknown> {
  if (process.env.LLV_DEPLOYMENT_ADAPTER_PROTOCOL !== "1") throw new Error("deployment adapter protocol is required");
  const action = process.argv[2];
  const input = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  reportAdapterPhase(String(action ?? "unknown"), "recovering an interrupted Viewer release switch");
  recoverInterruptedReleaseSwitch();
  if (action === "bootstrap-release") return runBootstrapRelease(input);
  const healthProbeCapability = typeof input.healthProbeCapability === "string"
    ? input.healthProbeCapability
    : undefined;
  if (action === "resolve-revision") return { revision: await resolveRevision(String(input.revision ?? "")) };
  if (action === "build-candidate") return buildCandidate(String(input.deploymentId ?? ""), String(input.revision ?? ""));
  if (action === "start-candidate") { await startCandidate(release(input.candidate)); return {}; }
  if (action === "current-release") {
    const current = readCurrentRelease();
    if (current === null) return null;
    const state = await containerState(current.container);
    if (state !== "running") throw new Error(`current release container is ${state}`);
    return current;
  }
  if (action === "current-mcp-runtime") return currentMcpRuntime();
  if (action === "reconcile-mcp-runtime") {
    const healthProbe = await delegatedHealthProbeAdmission(healthProbeCapability);
    return reconcileMcpRuntime(
      String(input.revision ?? ""),
      healthProbe,
    );
  }
  if (action === "verify-candidate") {
    const candidate = release(input.candidate);
    const healthProbe = await delegatedHealthProbeAdmission(healthProbeCapability);
    return verify(candidate, candidate.endpoint, {
      ...(healthProbe ?? {}),
    });
  }
  if (action === "promote") {
    const candidate = release(input.candidate);
    if (candidate.mcpRuntime?.source !== "managed") throw new Error("candidate MCP runtime identity is missing");
    return promoteTarget(candidate, (phase) => reportAdapterPhase(action, phase));
  }
  if (action === "verify-promoted") {
    reportAdapterPhase(action, promotedViewerReadinessPhase(null));
    const candidate = release(input.candidate);
    const healthProbe = await delegatedHealthProbeAdmission(healthProbeCapability);
    return verify(candidate, stableEndpoint, {
      expectedAssetsEndpoint: candidate.endpoint,
      reportPhase: (phase) => reportAdapterPhase(action, phase),
      ...(healthProbe ?? {}),
    });
  }
  if (action === "rollback") {
    const previous = release(input.previous);
    reportAdapterPhase(action, "starting the rollback Viewer release");
    await startCandidate(previous);
    reportAdapterPhase(action, "verifying the rollback Viewer release");
    const evidence = await verifyViewer(previous, previous.endpoint);
    if (!evidence.ok) throw new Error(evidence.detail ?? "rollback release health gate failed");
    const previousMcpRuntime = mcpRuntime(input.previousMcpRuntime);
    const candidate = release(input.candidate);
    reportAdapterPhase(action, "fencing the promoted SQLite release");
    const fence = await fenceCurrentSqliteRelease(candidate.revision, previous);
    return switchTarget(
      previous,
      "restore",
      previousMcpRuntime,
      fence,
      (phase) => reportAdapterPhase(action, phase),
    );
  }
  if (action === "stage-host-successor") {
    const candidate = release(input.candidate);
    await stageRuntimeHostSuccessor(candidate);
    return {};
  }
  if (action === "complete-host-handoff") {
    const generation = runtimeHostGeneration(input.generation);
    await completeRuntimeHostHandoff(generation, {
      docker: (argv) => command(["docker", ...argv]),
      readHandoffIntent: () => readRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile()),
      clearHandoffIntent: () => clearRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile()),
    });
    return {};
  }
  if (action === "retire") { await retireRelease(release(input.release)); return {}; }
  if (action === "retain-only") {
    if (!Array.isArray(input.releases)) throw new Error("retained releases are invalid");
    await retainOnly(input.releases.map(release));
    return {};
  }
  throw new Error("deployment adapter action is unsupported");
}

if (import.meta.main) {
  let output: string;
  let exitCode = 0;
  try {
    output = `${JSON.stringify(await main())}\n`;
  } catch (error) {
    output = `${error instanceof Error ? error.message : "deployment adapter failed"}\n`;
    exitCode = 1;
  }
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  await new Promise<void>((resolve, reject) => {
    stream.write(output, (error) => error ? reject(error) : resolve());
  });
  process.exit(exitCode);
}
