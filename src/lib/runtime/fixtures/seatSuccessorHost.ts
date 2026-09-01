import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";

import { CodexAppServerHost } from "../codexAppServerHost";
import { FileRuntimeEventStore } from "../eventStore";
import { adoptCodexRegistryHosts, bindCodexHostPersistence } from "../registry";

const [mode, registryPath, eventsPath, transcriptPath, mcpProofPath, readyPath] = process.argv.slice(2);
if ((mode !== "incumbent" && mode !== "successor")
  || !registryPath || !eventsPath || !transcriptPath || !mcpProofPath || !readyPath) {
  throw new Error("seat-successor host fixture arguments are invalid");
}

const engineFixture = path.join(import.meta.dir, "codexSeatSuccessor.ts");
const eventStore = new FileRuntimeEventStore(eventsPath);
const registry = new AgentRegistry(registryPath);
let host: CodexAppServerHost | null = null;
let stopping = false;

function spawnEngine(engineMode: "hold" | "probe") {
  return (_command: string, _args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams => spawn(
    process.execPath,
    [engineFixture, engineMode, mcpProofPath, transcriptPath],
    { ...options, stdio: ["pipe", "pipe", "pipe"] },
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

function writeReady(value: unknown): void {
  const temporary = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, readyPath);
}

function hostIdentity(current: CodexAppServerHost) {
  return current.health().then((health) => {
    if (!health.pid || !health.processStartIdentity) throw new Error("fixture engine process identity is unavailable");
    const viewer = captureProcessIdentity(process.pid);
    if (!viewer.startIdentity) throw new Error("fixture Viewer process identity is unavailable");
    return {
      viewer: { pid: viewer.pid, startIdentity: viewer.startIdentity },
      engine: { pid: health.pid, startIdentity: health.processStartIdentity },
      eventCursor: health.eventCursor,
      activeTurnRef: health.activeTurnRef,
    };
  });
}

async function startIncumbent(): Promise<void> {
  host = await CodexAppServerHost.start({
    cwd: process.cwd(),
    env: process.env,
    mcpServers: ["viewer"],
    eventStore,
    requestTimeoutMs: 5_000,
    shutdownGraceMs: 250,
    spawnProcess: spawnEngine("hold"),
  });
  const key = { engine: "codex" as const, sessionId: host.identity.threadId };
  registry.upsert({
    key,
    artifactPath: transcriptPath,
    cwd: process.cwd(),
    accountId: null,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const claimed = registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true });
  if (!claimed?.claimOwner) throw new Error("the incumbent fixture host claim was unavailable");
  await bindCodexHostPersistence(
    registry,
    key,
    host,
    claimed.claimOwner,
    claimed.claimEpoch,
    "dead",
    { cursorDebounceMs: 0 },
  );
  const receipt = await host.send({ id: "seat-successor-held-turn", text: "hold this turn" });
  if (receipt.outcome !== "turn-started") throw new Error("the incumbent fixture turn did not start");
  await waitFor(async () => (await host!.health()).status === "active", "the incumbent fixture turn stayed idle");
  writeReady({
    mode,
    sessionId: key.sessionId,
    ...(await hostIdentity(host)),
  });
}

async function startSuccessor(): Promise<void> {
  const adopted = await adoptCodexRegistryHosts(
    registry,
    () => ({
      cwd: process.cwd(),
      env: process.env,
      mcpServers: ["viewer"],
      eventStore,
      requestTimeoutMs: 5_000,
      shutdownGraceMs: 250,
      spawnProcess: spawnEngine("probe"),
    }),
    { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
  );
  if (adopted.length !== 1) throw new Error(`expected one adopted seat, received ${adopted.length}`);
  host = adopted[0]!.host;
  const receipt = await host.send({ id: "seat-successor-mcp-turn", text: "call Viewer MCP" });
  if (receipt.outcome !== "turn-started") throw new Error("the successor fixture turn did not start");
  await waitFor(() => fs.existsSync(mcpProofPath), "the successor fixture produced no Viewer MCP proof");
  const proof = JSON.parse(fs.readFileSync(mcpProofPath, "utf8")) as { error?: string };
  if (proof.error) throw new Error(proof.error);
  await waitFor(async () => (await host!.health()).status === "idle", "the successor fixture turn did not complete");
  writeReady({
    mode,
    sessionId: adopted[0]!.key.sessionId,
    ...(await hostIdentity(host)),
    proof,
  });
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await releaseHost();
  process.exit(0);
}

async function releaseHost(): Promise<void> {
  const current: CodexAppServerHost | null = host;
  if (current) await current.release().catch(() => {});
}

process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });

try {
  if (mode === "incumbent") await startIncumbent();
  else await startSuccessor();
  await new Promise<void>(() => {});
} catch (error) {
  writeReady({
    mode,
    error: error instanceof Error ? error.message : String(error),
  });
  await releaseHost();
  process.exitCode = 1;
}
