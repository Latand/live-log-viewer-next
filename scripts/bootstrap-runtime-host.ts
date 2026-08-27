#!/usr/bin/env bun
/* #1216 runtime-host bootstrap — the path onto a new revision that does NOT
   require a promote to have already succeeded.
 *
 * A deployment only replaces the runtime host in its `host-handoff` phase,
 * which is downstream of `promoting`. So a promote defect pins the host to the
 * revision carrying that defect, and the repair cannot be delivered by the
 * mechanism it repairs. This entry point runs on the HOST with `bun`, from a
 * checkout of the revision being installed, and drives the same #518 staging
 * the deployment would have driven.
 *
 * Modes, in ascending order of what they touch:
 *   (default)     render the plan and exit; nothing on the machine changes
 *   --stage       build the image and stage the successor; nothing is stopped
 *   --hand-over   --stage, then stop the predecessor so the successor takes
 *                 the singleton fence
 *
 * The plan is always rendered first, and it names the one container a
 * hand-over stops and the containers it never touches. Viewer releases, the
 * structured and engine hosts inside them, and every live agent session keep
 * running across all three modes.
 */

import fs from "node:fs";
import path from "node:path";

import type { ViewerReleaseIdentity } from "../src/lib/runtime/contracts";
import { ensureCanonicalMirror, resolveCanonicalRevision } from "../src/runtime-host/canonicalMirror";
import {
  executeRuntimeHostBootstrap,
  planRuntimeHostBootstrap,
  renderRuntimeHostBootstrapPlan,
  runtimeHostBootstrapRefusal,
  type RuntimeHostBootstrapMode,
} from "../src/runtime-host/hostBootstrap";
import {
  clearRuntimeHostHandoffIntent,
  readRuntimeHostHandoffIntent,
  readRuntimeHostRelease,
  runtimeHostHandoffIntentFile,
  runtimeHostReleaseFile,
  writeRuntimeHostHandoffIntent,
  writeRuntimeHostRelease,
} from "../src/runtime-host/hostRelease";
import {
  findRuntimeHostPredecessor,
  stageRuntimeHostSuccessorContainer,
} from "../src/runtime-host/hostSuccessor";
import { withoutWakatimeCredential } from "../src/lib/wakatime/credential";

const USAGE = "usage: bun scripts/bootstrap-runtime-host.ts [origin/main|<40-hex sha>] [--stage|--hand-over]";

const defaultConfigDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");
const stateDir = process.env.LLV_STATE_DIR || path.join(defaultConfigDir, "agent-log-viewer", "state");
const deploymentDir = path.join(stateDir, "deployments");
const mirrorDir = path.join(deploymentDir, "canonical.git");
const canonicalRemote = process.env.LLV_VIEWER_CANONICAL_REMOTE || "https://github.com/Latand/live-log-viewer-next.git";
const runtimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET || path.join(stateDir, "runtime-host.sock");
const runtimeHostImageTag = process.env.LLV_RUNTIME_HOST_IMAGE_TAG || "agent-log-viewer:node22";
const stableEndpoint = `http://127.0.0.1:${Number(process.env.LLV_VIEWER_PORT || 8898)}`;
const PREDECESSOR_STOP_GRACE_SECONDS = 40;

export function parseArguments(argv: string[]): { revision: string; mode: RuntimeHostBootstrapMode } {
  let revision: string | null = null;
  let mode: RuntimeHostBootstrapMode = "plan";
  for (const argument of argv) {
    if (argument === "--stage") { mode = "stage"; continue; }
    if (argument === "--hand-over") { mode = "hand-over"; continue; }
    if (argument.startsWith("-")) throw new Error(`unsupported option ${argument}\n${USAGE}`);
    if (revision !== null) throw new Error(`only one revision may be given\n${USAGE}`);
    revision = argument;
  }
  const requested = revision ?? "origin/main";
  if (requested !== "origin/main" && !/^[0-9a-f]{40}$/.test(requested)) {
    throw new Error(`invalid revision: use origin/main or a full lowercase commit SHA\n${USAGE}`);
  }
  return { revision: requested, mode };
}

async function command(argv: string[], options: { cwd?: string } = {}): Promise<string> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: withoutWakatimeCredential(process.env),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error((stderr.trim() || `${argv[0]} failed`).slice(0, 1000));
  return stdout.trim();
}

/** The image build is the one step that runs for minutes, so its progress goes
    to the operator's terminal instead of into a buffer they only see if it
    fails. */
async function streamedCommand(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, {
    stdout: "inherit",
    stderr: "inherit",
    env: withoutWakatimeCredential(process.env),
  });
  if (await child.exited !== 0) throw new Error(`${argv[0]} failed`);
}

function log(line: string): void {
  console.error(`[runtime-host bootstrap] ${line}`);
}

async function docker(argv: string[]): Promise<string> {
  return command(["docker", ...argv]);
}

async function containerPid(container: string): Promise<number | null> {
  try {
    const raw = await docker(["container", "inspect", "--format", "{{.State.Pid}}", container]);
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function fenceOwnerPid(): number | null {
  try {
    const owner = JSON.parse(fs.readFileSync(`${runtimeSocket}.lock`, "utf8")) as { pid?: unknown };
    return Number.isInteger(owner.pid) && (owner.pid as number) > 0 ? owner.pid as number : null;
  } catch {
    return null;
  }
}

async function imageExists(image: string): Promise<boolean> {
  try { await docker(["image", "inspect", image]); return true; }
  catch { return false; }
}

/** The same build a deployment runs, from a clean canonical worktree, minus
    everything a Viewer candidate needs and a runtime-host generation does not:
    no candidate container, no candidate port, no MCP runtime staging, and no
    change to the Viewer release target. */
async function buildRuntimeHostImage(revision: string, image: string): Promise<void> {
  const runtimeHome = process.env.HOME?.trim();
  if (!runtimeHome || !path.isAbsolute(runtimeHome)) {
    throw new Error("HOME must be an absolute path before building a runtime-host image");
  }
  if (await imageExists(image)) {
    log(`reusing the existing image for ${revision}`);
    return;
  }
  const sourceDir = path.join(deploymentDir, `runtime-host-bootstrap-${revision}`, "source");
  fs.rmSync(path.dirname(sourceDir), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true, mode: 0o700 });
  await command(["git", "--git-dir", mirrorDir, "worktree", "prune"]);
  await command(["git", "--git-dir", mirrorDir, "worktree", "add", "--detach", sourceDir, revision]);
  try {
    log(`building the runtime-host image for ${revision}; this takes several minutes`);
    await streamedCommand([
      "docker", "build", "--pull",
      "--build-arg", `LLV_RUNTIME_HOME=${runtimeHome}`,
      "--label", `dev.live-log-viewer.revision=${revision}`,
      "-t", image, sourceDir,
    ]);
  } finally {
    try { await command(["git", "--git-dir", mirrorDir, "worktree", "remove", "--force", sourceDir]); }
    catch { fs.rmSync(sourceDir, { recursive: true, force: true }); }
  }
}

async function main(): Promise<number> {
  const { revision: requested, mode } = parseArguments(process.argv.slice(2));
  const revision = await resolveCanonicalRevision(
    requested,
    { mirrorDir, remote: canonicalRemote },
    {
      run: command,
      ensureMirror: () => ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: canonicalRemote }, { run: command }),
    },
  );
  const image = `agent-log-viewer:hostboot-${revision}`;
  const predecessor = await findRuntimeHostPredecessor({ docker, fenceOwnerPid });
  const plan = planRuntimeHostBootstrap({ mode, revision, image, predecessor, stableEndpoint });
  console.log(renderRuntimeHostBootstrapPlan(plan));
  const refusal = runtimeHostBootstrapRefusal(plan);
  if (refusal) {
    log(`refused: ${refusal}`);
    return 1;
  }
  if (mode === "plan") {
    log("plan only; nothing on this machine has changed");
    log("re-run with --stage to create the successor, or --hand-over to also stop the predecessor");
    return 0;
  }
  const currentRelease = readRuntimeHostRelease(runtimeHostReleaseFile());
  log(`the durable runtime-host release record currently names ${currentRelease?.revision ?? "no staged generation"}`);
  await buildRuntimeHostImage(revision, image);
  const candidate: ViewerReleaseIdentity = {
    revision,
    image,
    container: plan.successorContainer,
    endpoint: stableEndpoint,
  };
  const outcome = await executeRuntimeHostBootstrap(plan, candidate, {
    stageSuccessor: (target) => stageRuntimeHostSuccessorContainer(target, runtimeHostImageTag, {
      docker,
      writeRelease: (record) => writeRuntimeHostRelease(record, runtimeHostReleaseFile()),
      readRelease: () => readRuntimeHostRelease(runtimeHostReleaseFile()),
      readHandoffIntent: () => readRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile()),
      writeHandoffIntent: (intent) => writeRuntimeHostHandoffIntent(intent, runtimeHostHandoffIntentFile()),
      clearHandoffIntent: () => clearRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile()),
      fenceOwnerPid,
      reportPhase: (phase) => log(phase),
    }),
    stopPredecessor: async (predecessorId) => {
      await docker(["container", "stop", "--time", String(PREDECESSOR_STOP_GRACE_SECONDS), predecessorId]);
    },
    successorPid: () => containerPid(plan.successorContainer),
    fenceOwnerPid,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    log,
  });
  if (!outcome.handedOver) {
    log(`successor ${outcome.successorContainer} is staged and idle; the predecessor still serves ${stableEndpoint}`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`[runtime-host bootstrap] ${error instanceof Error ? error.message : "bootstrap failed"}`);
    process.exit(1);
  }
}
