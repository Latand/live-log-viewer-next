import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { statePath } from "@/lib/configDir";
import { procBackend, type ProcBackend } from "@/lib/proc";
import type { ViewerHealthEvidence, ViewerReleaseIdentity } from "@/lib/runtime/contracts";

import type { ViewerDeploymentAdapter } from "./deployment";

type CommandRunner = (action: string, input: Record<string, unknown>) => Promise<unknown>;
type AdapterAction = "resolve-revision" | "build-candidate" | "start-candidate" | "current-release" | "verify-candidate" | "promote" | "verify-promoted" | "rollback" | "retire" | "retain-only";

const ACTION_TIMEOUTS: Record<AdapterAction, number> = {
  "resolve-revision": 110_000,
  "build-candidate": 30 * 60_000,
  "start-candidate": 60_000,
  "current-release": 90_000,
  "verify-candidate": 90_000,
  promote: 30_000,
  "verify-promoted": 90_000,
  rollback: 30_000,
  retire: 60_000,
  "retain-only": 60_000,
};

interface AdapterProcessRecord {
  pid: number;
  startIdentity: string;
  action: AdapterAction;
}

export interface HostCommandViewerDeploymentAdapterOptions {
  stateFile?: string;
  timeouts?: Partial<Record<AdapterAction, number>>;
  proc?: ProcBackend;
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
  return { image: item.image, container: item.container, endpoint: item.endpoint, revision: item.revision };
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
  ) throw new Error("deployment adapter returned invalid health evidence");
  return {
    checkedAt: item.checkedAt,
    endpoint: item.endpoint,
    processReady: item.processReady,
    rootStatus: item.rootStatus,
    authenticatedStatus: item.authenticatedStatus,
    unauthorizedStatus: item.unauthorizedStatus,
    assets: assets.map((asset) => ({ path: asset.path as string, status: asset.status as number })),
    ok: item.ok,
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
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
    const proc = options.proc ?? procBackend;
    const timeouts = { ...ACTION_TIMEOUTS, ...options.timeouts };
    const reconcile = async () => {
      const previous = readProcessRecord(stateFile);
      if (!previous) { clearProcessRecord(stateFile); return; }
      await terminateAdapterProcess(previous, proc);
      clearProcessRecord(stateFile, previous);
    };
    return new HostCommandViewerDeploymentAdapter(async (rawAction, input) => {
      const action = rawAction as AdapterAction;
      await reconcile();
      const child = spawn("/usr/bin/setpriv", ["--pdeathsig", "KILL", "--", executable, action], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LLV_DEPLOYMENT_ADAPTER_PROTOCOL: "1" },
        detached: true,
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(input));
      if (!child.pid) throw new Error("deployment adapter process did not start");
      const exitPromise = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      let startIdentity: string;
      try { startIdentity = await waitForProcessIdentity(child.pid, proc); }
      catch (error) { signalProcessGroup(child.pid, "SIGKILL"); await exitPromise; throw error; }
      const record: AdapterProcessRecord = { pid: child.pid, startIdentity, action };
      try { writeProcessRecord(stateFile, record); }
      catch (error) { await terminateAdapterProcess(record, proc); await exitPromise; throw error; }
      const stdoutPromise = readStream(child.stdout);
      const stderrPromise = readStream(child.stderr);
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const timeoutMs = Math.max(1, timeouts[action]);
        const outcome = await Promise.race([
          exitPromise.then((exitCode) => ({ type: "exit" as const, exitCode })),
          new Promise<{ type: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs); }),
        ]);
        if (outcome.type === "timeout") {
          await terminateAdapterProcess(record, proc);
          await exitPromise;
          await Promise.all([stdoutPromise, stderrPromise]);
          throw new Error(`deployment adapter ${action} timed out`);
        }
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        if (outcome.exitCode !== 0) throw new Error((stderr.trim() || `deployment adapter ${action} failed`).slice(0, 500));
        try { return JSON.parse(stdout) as unknown; }
        catch { throw new Error(`deployment adapter ${action} returned invalid JSON`); }
      } finally {
        if (timer) clearTimeout(timer);
        clearProcessRecord(stateFile, record);
      }
    }, reconcile);
  }

  reconcile(): Promise<void> { return this.reconcileProcess(); }

  async resolveRevision(revision: string): Promise<string> {
    const result = object(await this.run("resolve-revision", { revision }));
    if (typeof result.revision !== "string") throw new Error("deployment adapter did not resolve a revision");
    return result.revision;
  }

  async buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity> {
    return release(await this.run("build-candidate", { deploymentId, revision }));
  }

  async startCandidate(candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("start-candidate", { candidate });
  }

  async currentRelease(): Promise<ViewerReleaseIdentity | null> {
    const result = await this.run("current-release", {});
    return result === null ? null : release(result);
  }

  async verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> {
    return evidence(await this.run("verify-candidate", { candidate }));
  }

  async promote(candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("promote", { candidate });
  }

  async verifyPromoted(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence> {
    return evidence(await this.run("verify-promoted", { candidate }));
  }

  async rollback(previous: ViewerReleaseIdentity, candidate: ViewerReleaseIdentity): Promise<void> {
    await this.run("rollback", { previous, candidate });
  }

  async retire(releaseIdentity: ViewerReleaseIdentity): Promise<void> {
    await this.run("retire", { release: releaseIdentity });
  }

  async retainOnly(releases: ViewerReleaseIdentity[]): Promise<void> {
    await this.run("retain-only", { releases });
  }
}
