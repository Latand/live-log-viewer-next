import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

import { statePath } from "@/lib/configDir";
import { procBackend, type ProcBackend } from "@/lib/proc";
import type {
  ViewerHealthEvidence,
  ViewerHealthProbeObservation,
  ViewerHealthReadiness,
  ViewerMcpRuntimeCallFailure,
  ViewerMcpRuntimeHealthEvidence,
  ViewerMcpRuntimeIdentity,
  ViewerMcpRuntimePublicationEvidence,
  ViewerMcpRuntimeReconciliation,
  ViewerReleaseIdentity,
  ViewerRuntimeHostHandoffEvidence,
  ViewerRuntimeHostHealthEvidence,
  ViewerRuntimeHostProbeEvidence,
} from "@/lib/runtime/contracts";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import type { ViewerDeploymentAdapter } from "./deployment";
import { PROMOTE_ACTION_TIMEOUT_MS } from "./deploymentHotState";
import type { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import {
  createMcpHealthProbeAdmissionChannel,
  serveMcpHealthProbeAdmissionChannel,
} from "./mcpHealthProbeAdmissionChannel";
import { runtimeHostSuccessorName } from "./hostSuccessor";
import { parseRuntimeHostHandoffEvidence } from "./runtimeHostStartup";

type CommandRunner = (action: string, input: Record<string, unknown>) => Promise<unknown>;
type AdapterAction = "resolve-revision" | "build-candidate" | "start-candidate" | "current-release" | "current-mcp-runtime" | "reconcile-mcp-runtime" | "verify-candidate" | "promote" | "verify-promoted" | "rollback" | "retire" | "retain-only" | "stage-host-successor" | "verify-host-successor" | "complete-host-handoff";

const ACTION_TIMEOUTS: Record<AdapterAction, number> = {
  "resolve-revision": 110_000,
  "build-candidate": 30 * 60_000,
  "start-candidate": 60_000,
  "current-release": 90_000,
  "current-mcp-runtime": 90_000,
  "reconcile-mcp-runtime": 10 * 60_000,
  /* #1254: the candidate's runtime host is rehearsed inside a container from
     its own image — one succession plus a bounded hold — on top of the Viewer
     and MCP probes this action already ran. */
  "verify-candidate": 240_000,
  /* #1216: strictly larger than the adapter-side hand-over budgets it
     contains, so the adapter reports its own named reason instead of being
     killed mid-wait and leaving the operator a bare phase string. */
  promote: PROMOTE_ACTION_TIMEOUT_MS,
  "verify-promoted": 120_000,
  rollback: 90_000,
  retire: 60_000,
  "retain-only": 60_000,
  "stage-host-successor": 60_000,
  "verify-host-successor": 5_000,
  "complete-host-handoff": 60_000,
};

const MCP_HEALTH_PROBE_ACTIONS: ReadonlySet<AdapterAction> = new Set([
  "reconcile-mcp-runtime",
  "verify-candidate",
  "verify-promoted",
]);

interface AdapterProcessRecord {
  pid: number;
  startIdentity: string;
  action: AdapterAction;
}

interface AdapterPhaseRecord {
  action: AdapterAction;
  phase: string;
}

/** Slow enough to stay quiet through a long build, fast enough that a stalled
    promote names its wait while it is still stalling. */
const PHASE_LOG_INTERVAL_MS = 5_000;

export interface HostCommandViewerDeploymentAdapterOptions {
  stateFile?: string;
  log?(...args: unknown[]): void;
  phaseLogIntervalMs?: number;
  timeouts?: Partial<Record<AdapterAction, number>>;
  proc?: ProcBackend;
  mcpHealthProbeAdmissions?: Pick<McpHealthProbeAdmissions, "issue" | "consume" | "revoke">;
}

function readProcessRecord(filename: string): AdapterProcessRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<AdapterProcessRecord>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.startIdentity !== "string" || typeof value.action !== "string" || !(value.action in ACTION_TIMEOUTS)) return null;
    return value as AdapterProcessRecord;
  } catch {
    return null;
  }
}

function writeProcessRecord(filename: string, record: AdapterProcessRecord): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function clearProcessRecord(filename: string, expected?: AdapterProcessRecord): void {
  if (expected) {
    const current = readProcessRecord(filename);
    if (current && (current.pid !== expected.pid || current.startIdentity !== expected.startIdentity)) return;
  }
  fs.rmSync(filename, { force: true });
}

function readAdapterPhase(filename: string, action: AdapterAction): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<AdapterPhaseRecord>;
    return value.action === action
      && typeof value.phase === "string"
      && /^[A-Za-z0-9 -]{1,160}$/.test(value.phase)
      ? value.phase
      : null;
  } catch {
    return null;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  const group = spawnSync("/bin/kill", [`-${signal.replace("SIG", "")}`, "--", `-${pid}`], { stdio: "ignore" });
  if (group.status === 0) return;
  try { process.kill(pid, signal); } catch { /* process exited */ }
}

async function waitForExit(record: AdapterProcessRecord, proc: ProcBackend, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (proc.processIdentity(record.pid) === record.startIdentity && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return proc.processIdentity(record.pid) !== record.startIdentity;
}

async function terminateAdapterProcess(record: AdapterProcessRecord, proc: ProcBackend): Promise<void> {
  if (proc.processIdentity(record.pid) !== record.startIdentity) return;
  signalProcessGroup(record.pid, "SIGTERM");
  if (await waitForExit(record, proc, 250)) return;
  signalProcessGroup(record.pid, "SIGKILL");
  await waitForExit(record, proc, 1_000);
}

async function waitForProcessIdentity(pid: number, proc: ProcBackend): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const identity = proc.processIdentity(pid);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("deployment adapter process identity is unavailable");
}

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment adapter returned invalid JSON");
  return value as Record<string, unknown>;
}

function release(value: unknown): ViewerReleaseIdentity {
  const item = object(value);
  if (typeof item.image !== "string" || typeof item.container !== "string" || typeof item.endpoint !== "string" || typeof item.revision !== "string") {
    throw new Error("deployment adapter returned an invalid release identity");
  }
  return {
    image: item.image,
    container: item.container,
    endpoint: item.endpoint,
    revision: item.revision,
    ...(item.hotStateBackend === "sqlite-v1" ? { hotStateBackend: item.hotStateBackend } : {}),
    ...(item.mcpRuntime === undefined ? {} : { mcpRuntime: mcpRuntime(item.mcpRuntime) }),
  };
}

function mcpRuntime(value: unknown): ViewerMcpRuntimeIdentity {
  const item = object(value);
  const source = item.source;
  const releaseId = item.releaseId;
  const stagedAt = item.stagedAt;
  if ((source !== "legacy" && source !== "managed")
    || typeof item.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(item.revision)
    || typeof item.artifactDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(item.artifactDigest)
    || (source === "managed" && (typeof releaseId !== "string" || !/^[a-z0-9-]+$/.test(releaseId)))
    || (source === "legacy" && releaseId !== null)
    || (source === "managed" && typeof stagedAt !== "string")
    || (source === "legacy" && stagedAt !== null)) {
    throw new Error("deployment adapter returned an invalid MCP runtime identity");
  }
  return {
    source,
    revision: item.revision,
    releaseId: releaseId as string | null,
    artifactDigest: item.artifactDigest,
    stagedAt: stagedAt as string | null,
  };
}

function publication(value: unknown): ViewerMcpRuntimePublicationEvidence {
  const item = object(value);
  const runtime = mcpRuntime(item);
  if ((item.action !== "activate" && item.action !== "restore")
    || typeof item.publishedAt !== "string"
    || item.durable !== true) {
    throw new Error("deployment adapter returned invalid MCP runtime publication evidence");
  }
  /* #1216: the hand-over summary is what the journal keeps about the promote's
     ordered hot-state steps, so it survives normalization here. */
  const hotStateHandOver = typeof item.hotStateHandOver === "string"
    ? item.hotStateHandOver.slice(0, 200)
    : null;
  return {
    ...runtime,
    action: item.action,
    publishedAt: item.publishedAt,
    durable: true,
    ...(hotStateHandOver ? { hotStateHandOver } : {}),
  };
}

const PROBE_NAMES: readonly ViewerHealthProbeObservation["name"][] = ["root", "authenticated", "unauthorized", "capability"];

/** The diagnosis a failed deploy leaves behind (#790) only survives if it
    crosses this boundary, so each field is recovered here rather than dropped
    as unknown. Absent fields stay absent: records written before they existed
    replay unchanged. */
function probeObservations(value: unknown): ViewerHealthProbeObservation[] {
  if (!Array.isArray(value)) throw new Error("deployment adapter returned invalid health evidence");
  return value.map((entry) => {
    const item = object(entry);
    if (!PROBE_NAMES.includes(item.name as ViewerHealthProbeObservation["name"])
      || typeof item.url !== "string"
      || typeof item.status !== "number"
      || typeof item.elapsedMs !== "number"
      || typeof item.expected !== "string"
      || typeof item.ok !== "boolean") throw new Error("deployment adapter returned invalid health evidence");
    return {
      name: item.name as ViewerHealthProbeObservation["name"],
      url: item.url,
      status: item.status,
      elapsedMs: item.elapsedMs,
      expected: item.expected,
      ok: item.ok,
      ...(typeof item.error === "string" ? { error: item.error } : {}),
      ...(typeof item.body === "string" ? { body: item.body } : {}),
    };
  });
}

function readinessRecord(value: unknown): ViewerHealthReadiness {
  const item = object(value);
  if (typeof item.attempts !== "number"
    || typeof item.maxAttempts !== "number"
    || typeof item.delayMs !== "number"
    || typeof item.elapsedMs !== "number") throw new Error("deployment adapter returned invalid health evidence");
  return {
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    delayMs: item.delayMs,
    elapsedMs: item.elapsedMs,
    ...(typeof item.firstDetail === "string" ? { firstDetail: item.firstDetail } : {}),
  };
}

function evidence(value: unknown): ViewerHealthEvidence {
  const item = object(value);
  const assets = Array.isArray(item.assets) ? item.assets.map((asset) => object(asset)) : [];
  if (
    typeof item.checkedAt !== "string"
    || typeof item.endpoint !== "string"
    || typeof item.processReady !== "boolean"
    || typeof item.rootStatus !== "number"
    || (item.authenticatedStatus !== null && typeof item.authenticatedStatus !== "number")
    || (item.unauthorizedStatus !== null && typeof item.unauthorizedStatus !== "number")
    || typeof item.ok !== "boolean"
    || assets.some((asset) => typeof asset.path !== "string" || typeof asset.status !== "number")
    || (item.containerLog !== undefined
      && (!Array.isArray(item.containerLog) || item.containerLog.some((line) => typeof line !== "string")))
  ) throw new Error("deployment adapter returned invalid health evidence");
  return {
    checkedAt: item.checkedAt,
    endpoint: item.endpoint,
    processReady: item.processReady,
    rootStatus: item.rootStatus,
    authenticatedStatus: item.authenticatedStatus,
    unauthorizedStatus: item.unauthorizedStatus,
    assets: assets.map((asset) => ({ path: asset.path as string, status: asset.status as number })),
    ...(item.observations === undefined ? {} : { observations: probeObservations(item.observations) }),
    ...(item.readiness === undefined ? {} : { readiness: readinessRecord(item.readiness) }),
    ...(item.containerLog === undefined ? {} : { containerLog: item.containerLog as string[] }),
    ...(item.mcpRuntime === undefined ? {} : { mcpRuntime: mcpHealthEvidence(item.mcpRuntime) }),
    ...(item.runtimeHost === undefined ? {} : { runtimeHost: runtimeHostEvidence(item.runtimeHost) }),
    ok: item.ok,
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
  };
}

function mcpHealthEvidence(value: unknown): ViewerMcpRuntimeHealthEvidence {
  const item = object(value);
  const calls = object(item.calls);
  if (typeof item.checkedAt !== "string"
    || typeof item.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(item.revision)
    || typeof item.artifactDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(item.artifactDigest)
    || typeof item.processReady !== "boolean"
    || !Array.isArray(item.tools)
    || item.tools.some((tool) => typeof tool !== "string")
    || typeof calls.deploymentStatus !== "boolean"
    || typeof calls.boardSnapshot !== "boolean"
    || typeof item.ok !== "boolean") {
    throw new Error("deployment adapter returned invalid MCP runtime health evidence");
  }
  const callFailures = mcpCallFailures(item.callFailures);
  return {
    checkedAt: item.checkedAt,
    revision: item.revision,
    artifactDigest: item.artifactDigest,
    processReady: item.processReady,
    tools: item.tools as string[],
    calls: {
      deploymentStatus: calls.deploymentStatus,
      boardSnapshot: calls.boardSnapshot,
    },
    ...(callFailures.length ? { callFailures } : {}),
    ok: item.ok,
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
  };
}

/** Why each refused read failed, carried across the adapter boundary. Dropping
    it here would return the deployment record to a pair of booleans, which is
    the defect the probe evidence exists to end (#790). */
function mcpCallFailures(value: unknown): ViewerMcpRuntimeCallFailure[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("deployment adapter returned invalid MCP runtime call failures");
  return value.map((entry) => {
    const failure = object(entry);
    if (typeof failure.tool !== "string"
      || typeof failure.error !== "string"
      || (failure.code !== undefined && typeof failure.code !== "string")) {
      throw new Error("deployment adapter returned invalid MCP runtime call failures");
    }
    return {
      tool: failure.tool,
      ...(failure.code === undefined ? {} : { code: failure.code as string }),
      error: failure.error,
    };
  });
}

/** How one endpoint answered while it was held. Counts are the whole substance
    of the rehearsal, so a set that arrives half-read is refused. */
function runtimeHostProbeCounts(value: unknown): ViewerRuntimeHostProbeEvidence {
  const item = object(value);
  if (typeof item.polls !== "number"
    || typeof item.answered !== "number"
    || typeof item.abandoned !== "number") {
    throw new Error("deployment adapter returned invalid runtime-host health evidence");
  }
  return { polls: item.polls, answered: item.answered, abandoned: item.abandoned };
}

/** The host's half of a candidate verification, carried into the durable record
    (#1254). A Bun pin reached production because everything that ran before
    promotion exercised the Viewer; the rehearsal exercises the host as well,
    and evidence dropped at this boundary leaves the record unable to say which
    runtime the host was started under, whether the succession completed, or how
    the handed-over endpoints answered — which reads exactly like the check that
    was never run. */
function runtimeHostEvidence(value: unknown): ViewerRuntimeHostHealthEvidence {
  const item = object(value);
  const succession = object(item.succession);
  const listener = object(item.listener);
  if (typeof item.checkedAt !== "string"
    || typeof item.runtime !== "string"
    || typeof succession.predecessorReadyMs !== "number"
    || typeof succession.successorTookOverMs !== "number"
    || typeof succession.completed !== "boolean"
    || typeof listener.windowMs !== "number"
    || typeof item.ok !== "boolean"
    || (item.log !== undefined && (!Array.isArray(item.log) || item.log.some((line) => typeof line !== "string")))) {
    throw new Error("deployment adapter returned invalid runtime-host health evidence");
  }
  return {
    checkedAt: item.checkedAt,
    runtime: item.runtime,
    succession: {
      predecessorReadyMs: succession.predecessorReadyMs,
      successorTookOverMs: succession.successorTookOverMs,
      completed: succession.completed,
    },
    listener: { windowMs: listener.windowMs, ...runtimeHostProbeCounts(item.listener) },
    socket: runtimeHostProbeCounts(item.socket),
    ok: item.ok,
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
    ...(item.log === undefined ? {} : { log: item.log as string[] }),
  };
}

/** `null` is the adapter's "the published runtime already matches" answer. */
function reconciliation(value: unknown): ViewerMcpRuntimeReconciliation | null {
  if (value === null) return null;
  const item = object(value);
  return {
    publication: publication(item.publication),
    health: mcpHealthEvidence(item.health),
  };
}

/**
 * Host-owned adapter protocol. The executable path comes from runtime-host
 * configuration. Request data is sent as one JSON document on stdin; it never
 * selects a command, executable, shell fragment, or Docker argument.
 */
export class HostCommandViewerDeploymentAdapter implements ViewerDeploymentAdapter {
  constructor(private readonly run: CommandRunner, private readonly reconcileProcess: () => Promise<void> = async () => {}) {}

  static fromExecutable(executable: string, options: HostCommandViewerDeploymentAdapterOptions = {}): HostCommandViewerDeploymentAdapter {
    if (!executable.startsWith("/")) throw new Error("viewer deployment adapter path must be absolute");
    const stateFile = options.stateFile ?? statePath("viewer-deployment-adapter-process.json");
    const phaseFile = `${stateFile}.phase`;
    const proc = options.proc ?? procBackend;
    const log = options.log ?? console.error;
    const phaseLogIntervalMs = Math.max(1, options.phaseLogIntervalMs ?? PHASE_LOG_INTERVAL_MS);
    const timeouts = { ...ACTION_TIMEOUTS, ...options.timeouts };
    const reconcile = async () => {
      const previous = readProcessRecord(stateFile);
      if (!previous) {
        clearProcessRecord(stateFile);
        fs.rmSync(phaseFile, { force: true });
        return;
      }
      await terminateAdapterProcess(previous, proc);
      clearProcessRecord(stateFile, previous);
      fs.rmSync(phaseFile, { force: true });
    };
    const runAction = async (
      action: AdapterAction,
      input: Record<string, unknown>,
      healthAdmissions?: Pick<McpHealthProbeAdmissions, "consume">,
    ): Promise<unknown> => {
      const timeoutMs = Math.max(1, timeouts[action]);
      const admissionChannel = healthAdmissions
        ? await createMcpHealthProbeAdmissionChannel()
        : null;
      const stdio: StdioOptions = admissionChannel
        ? ["pipe", "pipe", "pipe", admissionChannel.childFd]
        : ["pipe", "pipe", "pipe"];
      let child: ReturnType<typeof spawn>;
      try {
        fs.rmSync(phaseFile, { force: true });
        child = spawn("/usr/bin/setpriv", ["--pdeathsig", "KILL", "--", executable, action], {
          stdio,
          env: {
            ...withoutWakatimeCredential(process.env),
            LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1",
            LLV_DEPLOYMENT_ADAPTER_PHASE_FILE: phaseFile,
            /* #1216: the deadline this host will enforce, so the adapter can
               fit its own waits inside it instead of being killed mid-wait. */
            LLV_DEPLOYMENT_ADAPTER_ACTION_DEADLINE_MS: String(timeoutMs),
          },
          detached: true,
        });
      } catch (error) {
        admissionChannel?.close();
        throw error;
      } finally {
        admissionChannel?.closeChildFd();
      }
      const closeHealthAdmission = healthAdmissions && admissionChannel
        ? (() => {
            const closeServing = serveMcpHealthProbeAdmissionChannel(
              admissionChannel.channel,
              healthAdmissions,
            );
            return () => {
              closeServing();
              admissionChannel.close();
            };
          })()
        : null;
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(input));
      if (!child.pid) {
        closeHealthAdmission?.();
        throw new Error("deployment adapter process did not start");
      }
      const exitPromise = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      let startIdentity: string;
      try { startIdentity = await waitForProcessIdentity(child.pid, proc); }
      catch (error) {
        signalProcessGroup(child.pid, "SIGKILL");
        await exitPromise;
        closeHealthAdmission?.();
        throw error;
      }
      const record: AdapterProcessRecord = { pid: child.pid, startIdentity, action };
      try { writeProcessRecord(stateFile, record); }
      catch (error) {
        await terminateAdapterProcess(record, proc);
        await exitPromise;
        closeHealthAdmission?.();
        throw error;
      }
      const stdoutPromise = readStream(child.stdout);
      const stderrPromise = readStream(child.stderr);
      let timer: ReturnType<typeof setTimeout> | null = null;
      /* #1216: a deployment used to leave no trace in the runtime-host log, so
         a promote that stalled was invisible next to the journal maintenance
         chatter. Phase transitions are the adapter's own progress report. */
      let reportedPhase: string | null = null;
      const phaseLog = setInterval(() => {
        const phase = readAdapterPhase(phaseFile, action);
        if (phase === null || phase === reportedPhase) return;
        reportedPhase = phase;
        log(`[viewer deployment] ${action} ${phase}`);
      }, phaseLogIntervalMs);
      phaseLog.unref?.();
      try {
        const outcome = await Promise.race([
          exitPromise.then((exitCode) => ({ type: "exit" as const, exitCode })),
          new Promise<{ type: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs); }),
        ]);
        if (outcome.type === "timeout") {
          await terminateAdapterProcess(record, proc);
          await exitPromise;
          await Promise.all([stdoutPromise, stderrPromise]);
          const phase = readAdapterPhase(phaseFile, action) ?? "waiting for the adapter process";
          throw new Error(`deployment adapter ${action} timed out while ${phase}`);
        }
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        if (outcome.exitCode !== 0) throw new Error((stderr.trim() || `deployment adapter ${action} failed`).slice(0, 500));
        try { return JSON.parse(stdout) as unknown; }
        catch { throw new Error(`deployment adapter ${action} returned invalid JSON`); }
      } finally {
        if (timer) clearTimeout(timer);
        clearInterval(phaseLog);
        closeHealthAdmission?.();
        clearProcessRecord(stateFile, record);
        fs.rmSync(phaseFile, { force: true });
      }
    };
    const run: CommandRunner = async (rawAction, input) => {
      const action = rawAction as AdapterAction;
      await reconcile();
      if (!MCP_HEALTH_PROBE_ACTIONS.has(action) || !options.mcpHealthProbeAdmissions) {
        return runAction(action, input);
      }
      const healthProbeCapability = options.mcpHealthProbeAdmissions.issue();
      try {
        return await runAction(action, { ...input, healthProbeCapability }, options.mcpHealthProbeAdmissions);
      } finally {
        options.mcpHealthProbeAdmissions.revoke(healthProbeCapability);
      }
    };
    return new HostCommandViewerDeploymentAdapter(run, reconcile);
  }

  reconcile(): Promise<void> { return this.reconcileProcess(); }

  async resolveRevision(revision: string): Promise<string> {
    const result = object(await this.run("resolve-revision", { revision }));
    if (typeof result.revision !== "string") throw new Error("deployment adapter did not resolve a revision");
    return result.revision;
  }

  async buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
    const candidate = release(await this.run("build-candidate", { deploymentId, revision }));
    if (candidate.mcpRuntime?.source !== "managed" || candidate.mcpRuntime.revision !== revision) {
      throw new Error("deployment adapter candidate MCP runtime does not match its revision");
    }
    return candidate;
  }

  async startCandidate(candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("start-candidate", { candidate });
  }

  async currentRelease(): Promise<ViewerReleaseIdentity | null> {
    const result = await this.run("current-release", {});
    return result === null ? null : release(result);
  }

  async currentMcpRuntime(): Promise<ViewerMcpRuntimeIdentity> {
    return mcpRuntime(await this.run("current-mcp-runtime", {}));
  }

  async reconcileMcpRuntime(revision: string): Promise<ViewerMcpRuntimeReconciliation | null> {
    return reconciliation(await this.run("reconcile-mcp-runtime", { revision }));
  }

  async verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> {
    return evidence(await this.run("verify-candidate", { candidate }));
  }

  async promote(candidate: ViewerReleaseIdentity): Promise<ViewerMcpRuntimePublicationEvidence> {
    return publication(await this.run("promote", { candidate }));
  }

  async verifyPromoted(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> {
    return evidence(await this.run("verify-promoted", { candidate }));
  }

  async rollback(
    previous: ViewerReleaseIdentity,
    candidate: ViewerReleaseIdentity,
    previousMcpRuntime: ViewerMcpRuntimeIdentity,
  ): Promise<ViewerMcpRuntimePublicationEvidence> {
    return publication(await this.run("rollback", { previous, candidate, previousMcpRuntime }));
  }

  async retire(releaseIdentity: ViewerReleaseIdentity): Promise<void> {
    await this.run("retire", { release: releaseIdentity });
  }

  async retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> {
    await this.run("retain-only", { releases });
  }

  async stageRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("stage-host-successor", { candidate });
  }

  async verifyRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<ViewerRuntimeHostHandoffEvidence> {
    const expected = {
      image: candidate.image,
      revision: candidate.revision,
      container: runtimeHostSuccessorName(candidate.revision, candidate.image),
    };
    return parseRuntimeHostHandoffEvidence(
      await this.run("verify-host-successor", { candidate }),
      expected,
    );
  }

  async completeRuntimeHostHandoff(generation: { image: string; revision: string; container: string }): Promise<void> {
    await this.run("complete-host-handoff", { generation });
  }
}
