/*
 * A Viewer generation, as a separate process (#1501 proof fixture).
 *
 * The integration test in ../stageHostGenerationClose.integration.test.ts
 * starts this file under `bun run` once per generation it needs. Each run is
 * a distinct process with its own pid and start identity, which is what the
 * registry's claim owner records — so "the generation that started this host
 * no longer exists" is a real process being gone, never a relabelled sleep.
 *
 *   spawn  — the incumbent: registers one structured stage conversation the
 *            way the Viewer's spawn writer does (a launch receipt, a settled
 *            row whose `structuredHost.process` is a controlled child this
 *            process started, `claimOwner` = this process), then stays alive.
 *   adopt  — a successor: runs the product's own startup adoption
 *            (`adoptStructuredHostsAtStartup`) against the isolated registry
 *            and the runtime host on LLV_RUNTIME_HOST_SOCKET. Only the CLI
 *            launch is substituted: an eligible Claude row is re-hosted by a
 *            controlled child and recorded through the registry's claim
 *            writers, exactly as `adoptClaudeRegistryHosts` does. The filter,
 *            the demotion of skipped rows, the transcript refresh and the
 *            delivery-controller binding are the real ones. Stays alive
 *            afterwards, as the generation that now owns what it adopted.
 *
 * Every controlled child is `sh -c 'exec sleep 300'`, detached, leading its
 * own process group. Nothing here is told apart by argv.
 *
 * Output: one JSON line on stdout when the step has settled; then the process
 * waits until it is killed. The environment is the caller's: HOME, XDG_CONFIG
 * _HOME, LLV_STATE_DIR, TMPDIR and LLV_RUNTIME_HOST_SOCKET must already point
 * at the isolated state the test owns.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AgentRegistry, type AgentRegistryEntry, type ProcessIdentity } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { createFakeDeliveryLedger, FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import { adoptStructuredHostsAtStartup } from "@/lib/runtime/startup";

const [mode, registryPath, laneDirectory, hostShape = "single"] = process.argv.slice(2);
if ((mode !== "spawn" && mode !== "adopt") || !registryPath || !laneDirectory || (hostShape !== "single" && hostShape !== "tree")) {
  throw new Error("usage: stageHostGeneration.ts <spawn|adopt> <registry path> <lane directory> [single|tree]");
}

const self = captureProcessIdentity(process.pid);
if (!self.startIdentity || !self.bootEpoch) throw new Error("this generation has no kernel identity to record");

/** A controlled host process: detached, its own group, the argv every role shares. */
function controlledHost(): ProcessIdentity {
  const child = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("controlled host did not start");
  const identity = captureProcessIdentity(child.pid);
  if (!identity.startIdentity || !identity.bootEpoch) throw new Error("controlled host has no kernel identity");
  return identity;
}

/** A controlled host that owns a descendant in its own session — the shape of
    an engine wrapper with a helper under it, which a group signal cannot reach
    on its own. Returns the root and the descendant. */
async function controlledHostTree(): Promise<{ root: ProcessIdentity; descendant: ProcessIdentity }> {
  const pidFile = path.join(laneDirectory, `descendant-${crypto.randomUUID()}.pid`);
  const child = spawn("/bin/sh", ["-c", 'setsid sleep 300 & echo $! > "$1"; wait', "host", pidFile], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("controlled host tree did not start");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0) break;
    await Bun.sleep(5);
  }
  const descendantPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const root = captureProcessIdentity(child.pid);
  const descendant = captureProcessIdentity(descendantPid);
  if (!root.startIdentity || !descendant.startIdentity) throw new Error("controlled host tree has no kernel identity");
  return { root, descendant };
}

function report(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ generation: self, ...payload })}\n`);
}

const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });

if (mode === "spawn") {
  const sessionId = crypto.randomUUID();
  const transcript = path.join(laneDirectory, `${sessionId}.jsonl`);
  /* A turn the transcript never closed: the shape a host leaves when the
     machine goes down mid-turn. The transcript refresh reads this as busy. */
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "start" } })}\n`);
  const begun = registry.beginSpawnRequest({
    engine: "claude",
    cwd: laneDirectory,
    transport: "structured",
    accountId: null,
    launchProfile: { title: "Stage host generation proof lane" },
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const tree = hostShape === "tree" ? await controlledHostTree() : null;
  const host = tree ? tree.root : controlledHost();
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId },
    artifactPath: transcript,
    cwd: laneDirectory,
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: `stdio:${host.pid}`,
      process: host,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(self)}`,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  report({
    conversationId: settled.conversation.id,
    launchId: begun.receipt.launchId,
    sessionId,
    transcriptPath: transcript,
    host,
    descendant: tree?.descendant ?? null,
  });
} else {
  const adopted: Array<{ key: string; host: ProcessIdentity }> = [];
  const considered: string[] = [];
  let deferred: string | null = null;
  const hosts = await adoptStructuredHostsAtStartup({
    registry,
    adopt: async () => [],
    /* The one substitution: the CLI launch. Selection is the product's. */
    adoptClaude: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      const rows = Object.values(received.readOnlySnapshot().entries).filter((entry: AgentRegistryEntry) =>
        entry.key.engine === "claude" && entry.structuredHost?.kind === "claude-broker");
      const result: Array<{ key: AgentRegistryEntry["key"]; host: never }> = [];
      for (const entry of rows) {
        considered.push(sessionKeyId(entry.key));
        if (!shouldAdopt(entry)) continue;
        const claimed = received.claimStructuredHost(entry.key, self, { allowUnhosted: true });
        if (!claimed?.structuredHost || !claimed.claimOwner) continue;
        const host = controlledHost();
        const written = received.setStructuredHostClaimed(
          entry.key,
          { ...claimed.structuredHost, endpoint: `stdio:${host.pid}`, process: host, activeTurnRef: null },
          "live",
          claimed.claimOwner,
          claimed.claimEpoch,
        );
        if (!written) throw new Error("the successor generation could not record its host");
        adopted.push({ key: sessionKeyId(entry.key), host });
        const engineHost = Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), { onStateChange: () => () => {} });
        result.push({ key: entry.key, host: engineHost as never });
      }
      return result;
    },
  }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith("pipeline startup evidence is unresolved")) throw error;
    deferred = error.message;
    return [];
  });
  report({
    deferred,
    adopted,
    considered,
    published: hosts.map((item) => sessionKeyId(item.key)),
    entries: Object.fromEntries(Object.values(registry.readOnlySnapshot().entries).map((entry) => [
      sessionKeyId(entry.key),
      { status: entry.status, claimOwner: entry.claimOwner, process: entry.structuredHost?.process ?? null },
    ])),
  });
}

/* Stay the generation that owns what it wrote, until the test ends it. */
await new Promise<never>(() => {});
