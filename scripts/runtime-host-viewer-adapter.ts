#!/usr/bin/env bun-container

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ViewerHealthEvidence, ViewerReleaseIdentity } from "../src/lib/runtime/contracts";
import {
  obsoleteManagedViewerContainers,
  viewerAuthenticationTokenFromConfig,
  viewerCandidateDockerArgs,
  viewerCandidateTmuxEnvironment,
  viewerComposeServiceFromConfig,
  viewerComposeServiceUid,
} from "../src/runtime-host/candidateContainer";
import { ensureCanonicalMirror } from "../src/runtime-host/canonicalMirror";
import { allocateBuiltCandidatePort, candidatePortsFromEnvironmentLists, isCandidatePortAvailable } from "../src/runtime-host/candidatePort";
import { viewerCandidateContainerName, viewerCandidateImageName, viewerComposeSnapshotName } from "../src/runtime-host/deploymentArtifacts";
import { bootstrapViewerRelease } from "../src/runtime-host/deploymentBootstrap";
import { hasViewerDeploymentCapability, viewerHealthRequestPlan, waitForViewerReadiness, type ViewerCandidateContainerState } from "../src/runtime-host/deploymentHealth";

const stateDir = process.env.LLV_STATE_DIR || "/home/latand/.config/agent-log-viewer/state";
const deploymentDir = path.join(stateDir, "deployments");
const mirrorDir = path.join(deploymentDir, "canonical.git");
const targetFile = process.env.LLV_VIEWER_DEPLOY_TARGET || path.join(stateDir, "viewer-release.json");
const canonicalRemote = process.env.LLV_VIEWER_CANONICAL_REMOTE || "https://github.com/Latand/live-log-viewer-next.git";
const runtimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET || path.join(stateDir, "runtime-host.sock");
const stableEndpoint = `http://127.0.0.1:${Number(process.env.LLV_VIEWER_PORT || 8898)}`;

async function command(argv: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/setpriv", "--pdeathsig", "KILL", "--", ...argv], { stdout: "pipe", stderr: "pipe", env: process.env });
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
  viewerComposeServiceFromConfig(config);
  const filename = composeConfigFile(container);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, config, { mode: 0o600, flag: "wx" });
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
  return item as ViewerReleaseIdentity;
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
  try {
    const composeConfig = await command([
      "docker", "compose", "--project-directory", sourceDir, "-f", path.join(sourceDir, "docker-compose.yml"),
      "--profile", "*", "config", "--format", "json",
    ]);
    writeComposeConfig(container, composeConfig);
    await command(["docker", "build", "--pull", "--label", `dev.live-log-viewer.revision=${revision}`, "-t", image, sourceDir]);
  } finally {
    try { await command(["git", "--git-dir", mirrorDir, "worktree", "remove", "--force", sourceDir]); }
    catch { fs.rmSync(sourceDir, { recursive: true, force: true }); }
  }
  const port = await allocateBuiltCandidatePort(deploymentId, {
    base: Number(process.env.LLV_VIEWER_CANDIDATE_PORT_BASE || 18_000),
    slots: 2_000,
    reservedPorts: managedCandidatePorts,
    isAvailable: isCandidatePortAvailable,
    removeImage: async () => { await command(["docker", "image", "rm", image]); },
    removeComposeSnapshot: () => { fs.rmSync(composeConfigFile(container), { force: true }); },
  });
  return { revision, image, container, endpoint: `http://127.0.0.1:${port}` };
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
}

async function retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> {
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
}

function serviceToken(candidate: ViewerReleaseIdentity): string | null {
  return viewerAuthenticationTokenFromConfig(fs.readFileSync(composeConfigFile(candidate.container), "utf8"));
}

async function fetchStatus(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(5_000) });
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
    && expectedAssetsMatch;
  return {
    checkedAt: new Date().toISOString(), endpoint, processReady, rootStatus: root.status,
    authenticatedStatus: authenticated?.status ?? null, unauthorizedStatus: unauthorized?.status ?? null, assets, ok,
    ...(ok ? {} : {
      detail: !deploymentCapable
        ? "Viewer deployment capability gate failed"
        : expectedAssetsMatch
          ? "Viewer health or referenced asset gate failed"
          : "stable listener does not serve the candidate asset set",
    }),
  };
}

async function verify(candidate: ViewerReleaseIdentity, endpoint: string, expectedAssetsEndpoint?: string): Promise<ViewerHealthEvidence> {
  return waitForViewerReadiness({
    endpoint,
    inspect: () => containerState(candidate.container),
    probe: () => probeRoutes(candidate, endpoint, expectedAssetsEndpoint),
  });
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
  try { return readTarget(); }
  catch { return null; }
}

function switchTarget(target: ViewerReleaseIdentity): void {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(target));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, targetFile);
  const dir = fs.openSync(path.dirname(targetFile), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
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
      publishTarget: async (candidate) => { switchTarget(candidate); },
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
    const health = await verify(current, stableEndpoint, current.endpoint);
    if (!health.ok) throw new Error("current release health verification failed");
    return current;
  }
  if (action === "verify-candidate") { const candidate = release(input.candidate); return verify(candidate, candidate.endpoint); }
  if (action === "promote") { switchTarget(release(input.candidate)); return {}; }
  if (action === "verify-promoted") { const candidate = release(input.candidate); return verify(candidate, stableEndpoint, candidate.endpoint); }
  if (action === "rollback") { switchTarget(release(input.previous)); return {}; }
  if (action === "retire") { await retireRelease(release(input.release)); return {}; }
  if (action === "retain-only") {
    if (!Array.isArray(input.releases)) throw new Error("retained releases are invalid");
    await retainOnly(input.releases.map(release));
    return {};
  }
  throw new Error("deployment adapter action is unsupported");
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "deployment adapter failed"}\n`);
  process.exitCode = 1;
}
