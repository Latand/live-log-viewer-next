#!/usr/bin/env bun-container

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ViewerHealthEvidence,
  ViewerMcpRuntimeIdentity,
  ViewerMcpRuntimePublicationEvidence,
  ViewerReleaseIdentity,
} from "../src/lib/runtime/contracts";
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
import { ensureCanonicalMirror } from "../src/runtime-host/canonicalMirror";
import { allocateBuiltCandidatePort, candidatePortsFromEnvironmentLists, isCandidatePortAvailable } from "../src/runtime-host/candidatePort";
import { viewerCandidateContainerName, viewerCandidateImageName, viewerComposeSnapshotName } from "../src/runtime-host/deploymentArtifacts";
import { bootstrapViewerRelease } from "../src/runtime-host/deploymentBootstrap";
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
  viewerDeploymentRegistryBackendMode,
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
const deploymentPackageRoot = path.resolve(import.meta.dir, "..");

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
  await ensureMirror();
  const value = requested === "origin/main" ? "refs/heads/main^{commit}" : `${requested}^{commit}`;
  const revision = await command(["git", "--git-dir", mirrorDir, "rev-parse", "--verify", value]);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("canonical repository returned an invalid revision");
  return revision;
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
  await ensureMirror();
  await command(["git", "--git-dir", mirrorDir, "cat-file", "-e", `${revision}^{commit}`]);
  const sourceDir = path.join(deploymentDir, deploymentId, "source");
  fs.rmSync(path.dirname(sourceDir), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true, mode: 0o700 });
  await command(["git", "--git-dir", mirrorDir, "worktree", "prune"]);
  await command(["git", "--git-dir", mirrorDir, "worktree", "add", "--detach", sourceDir, revision]);
  const container = viewerCandidateContainerName(deploymentId);
  const image = viewerCandidateImageName(revision, container);
  let mcpRuntime: ViewerMcpRuntimeIdentity | null = null;
  try {
    const composeConfig = await command([
      "docker", "compose", "--project-directory", sourceDir, "-f", path.join(sourceDir, "docker-compose.yml"),
      "--profile", "*", "config", "--format", "json",
    ]);
    writeComposeConfig(container, composeConfig);
    await command(["docker", "build", "--pull", "--label", `dev.live-log-viewer.revision=${revision}`, "-t", image, sourceDir]);
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
    return { revision, image, container, endpoint: `http://127.0.0.1:${port}`, mcpRuntime };
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

async function probeRoutes(candidate: ViewerReleaseIdentity, endpoint: string, expectedAssetsEndpoint?: string): Promise<ViewerHealthEvidence> {
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
    && expectedAssetsMatch;
  return {
    checkedAt: new Date().toISOString(), endpoint, processReady, rootStatus: root.status,
    authenticatedStatus: authenticated?.status ?? null, unauthorizedStatus: unauthorized?.status ?? null, assets, ok,
    ...(ok ? {} : {
      detail: !deploymentCapable
        ? "Viewer deployment capability gate failed"
        : !registryBackendMatches
          ? `Viewer registry backend mode mismatch: expected ${expectedRegistryBackendMode}, observed ${observedRegistryBackendMode ?? "unavailable"}`
        : expectedAssetsMatch
          ? "Viewer health or referenced asset gate failed"
          : "stable listener does not serve the candidate asset set",
    }),
  };
}

async function verifyViewer(candidate: ViewerReleaseIdentity, endpoint: string, expectedAssetsEndpoint?: string): Promise<ViewerHealthEvidence> {
  return waitForViewerReadiness({
    endpoint,
    inspect: () => containerState(candidate.container),
    probe: () => probeRoutes(candidate, endpoint, expectedAssetsEndpoint),
  });
}

async function verify(candidate: ViewerReleaseIdentity, endpoint: string, expectedAssetsEndpoint?: string): Promise<ViewerHealthEvidence> {
  const viewer = await verifyViewer(candidate, endpoint, expectedAssetsEndpoint);
  if (!viewer.ok) return viewer;
  if (!candidate.mcpRuntime || candidate.mcpRuntime.source !== "managed") {
    return { ...viewer, ok: false, detail: "candidate MCP runtime identity is missing" };
  }
  const promoted = expectedAssetsEndpoint !== undefined;
  const probeTarget = promoted
    ? targetFile
    : path.join(stateDir, `mcp-candidate-probe-${candidate.mcpRuntime.releaseId}.json`);
  if (!promoted) writeReleaseTarget(probeTarget, candidate);
  const probeEnvironment = Object.fromEntries(Object.entries(withoutWakatimeCredential(process.env))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  probeEnvironment.LLV_VIEWER_DEPLOY_TARGET = probeTarget;
  const mcpRuntime = await probeMcpRuntime({
    command: process.execPath,
    args: [path.join(mcpRuntimeRoot, "bin", "mcp-server.mjs")],
    cwd: mcpRuntimeRoot,
    env: probeEnvironment,
    runtime: candidate.mcpRuntime,
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

function writeReleaseTarget(filename: string, target: ViewerReleaseIdentity): void {
  mcpRuntimeStore.publishReleaseTarget(filename, target);
}

function switchTarget(
  target: ViewerReleaseIdentity,
  action: ViewerMcpRuntimePublicationEvidence["action"],
  fallbackRuntime?: ViewerMcpRuntimeIdentity,
): ViewerMcpRuntimePublicationEvidence {
  const runtime = target.mcpRuntime ?? fallbackRuntime;
  if (!runtime) throw new Error("release MCP runtime identity is missing");
  if (runtime.source === "managed" && runtime.revision !== target.revision) {
    throw new Error("release MCP runtime revision does not match the Viewer revision");
  }
  writeReleaseTarget(targetFile, target);
  return {
    action,
    ...runtime,
    publishedAt: new Date().toISOString(),
    durable: true,
  };
}

async function currentMcpRuntime(): Promise<ViewerMcpRuntimeIdentity> {
  const current = readCurrentRelease();
  if (current?.mcpRuntime) return current.mcpRuntime;
  const revision = await command(["git", "-C", mcpRuntimeRoot, "rev-parse", "HEAD"]);
  return mcpRuntimeStore.legacyRuntimeIdentity(revision);
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

async function main(): Promise<unknown> {
  if (process.env.LLV_DEPLOYMENT_ADAPTER_PROTOCOL !== "1") throw new Error("deployment adapter protocol is required");
  const action = process.argv[2];
  const input = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  if (action === "bootstrap-release") {
    return bootstrapViewerRelease(String(input.revision ?? "origin/main"), `bootstrap-${randomUUID()}`, {
      targetExists: () => fs.existsSync(targetFile),
      resolveRevision,
      buildCandidate,
      startCandidate,
      verifyCandidate: (candidate) => verify(candidate, candidate.endpoint),
      publishTarget: async (candidate) => { switchTarget(candidate, "activate"); },
      targetMatches: (candidate) => releasesEqual(readTarget(), candidate),
      retireCandidate: retireRelease,
    });
  }
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
  if (action === "verify-candidate") { const candidate = release(input.candidate); return verify(candidate, candidate.endpoint); }
  if (action === "promote") {
    const candidate = release(input.candidate);
    if (candidate.mcpRuntime?.source !== "managed") throw new Error("candidate MCP runtime identity is missing");
    return switchTarget(candidate, "activate");
  }
  if (action === "verify-promoted") { const candidate = release(input.candidate); return verify(candidate, stableEndpoint, candidate.endpoint); }
  if (action === "rollback") {
    const previous = release(input.previous);
    await startCandidate(previous);
    const evidence = await verifyViewer(previous, previous.endpoint);
    if (!evidence.ok) throw new Error(evidence.detail ?? "rollback release health gate failed");
    const previousMcpRuntime = mcpRuntime(input.previousMcpRuntime);
    return switchTarget(previous, "restore", previousMcpRuntime);
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
