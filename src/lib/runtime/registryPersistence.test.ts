import { describe, expect, test } from "bun:test";

import type { AgentRegistry, AgentRegistryEntry, StructuredHostColumns } from "@/lib/agent/registry";

import type { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import type { CodexAppServerHost } from "./codexAppServerHost";
import type { HostState } from "./engineHost";
import { bindClaudeHostPersistence, bindCodexHostPersistence } from "./registry";

const KEY = { engine: "codex" as const, sessionId: "coalesced-host" };

function hostState(overrides: Partial<HostState> = {}): HostState {
  return {
    status: "idle",
    sessionKey: KEY.sessionId,
    endpoint: "stdio:4242",
    pid: 4242,
    processStartIdentity: "4242:100",
    eventCursor: 0,
    protocolVersion: "1.0.0",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
    ...overrides,
  };
}

class RecordingRegistry {
  readonly writes: Array<{ columns: StructuredHostColumns; status: string; releaseClaim: boolean }> = [];
  readonly releases: number[] = [];
  acceptWrites = true;

  ownsStructuredHostClaim(): boolean { return true; }

  setStructuredHostClaimed(
    _key: unknown,
    columns: StructuredHostColumns,
    status: string,
    _claimOwner: string,
    writerClaimEpoch: number,
    releaseClaim = false,
  ): AgentRegistryEntry | null {
    this.writes.push({ columns: structuredClone(columns), status, releaseClaim });
    if (!this.acceptWrites) return null;
    return { structuredHost: columns, status, claimEpoch: writerClaimEpoch } as AgentRegistryEntry;
  }

  releaseStructuredHostClaim(_key: unknown, _owner: string, epoch: number): void {
    this.releases.push(epoch);
  }
}

class RecordingHost {
  private readonly listeners = new Set<(state: HostState) => void>();
  private state = hostState();
  releaseCalls = 0;

  setWriterFence(): void {}
  async health(): Promise<HostState> { return structuredClone(this.state); }
  onStateChange(listener: (state: HostState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async release(): Promise<void> { this.releaseCalls += 1; }

  emit(overrides: Partial<HostState>): void {
    this.state = hostState({ ...this.state, ...overrides });
    for (const listener of this.listeners) listener(structuredClone(this.state));
  }
}

type Binder = (
  registry: AgentRegistry,
  host: RecordingHost,
  options?: { cursorDebounceMs: number },
) => Promise<() => void>;

const binders: Array<[string, Binder]> = [
  ["Codex", (registry, host, options) => bindCodexHostPersistence(
    registry,
    KEY,
    host as unknown as CodexAppServerHost,
    "writer",
    7,
    "unhosted",
    options,
  )],
  ["Claude", (registry, host, options) => bindClaudeHostPersistence(
    registry,
    { ...KEY, engine: "claude" },
    host as unknown as ClaudeStreamBrokerHost,
    "writer",
    7,
    "unhosted",
    options,
  )],
];

for (const [engine, bind] of binders) {
  describe(`${engine} structured host persistence`, () => {
    test("bounds registry mutations across ten streaming lanes", async () => {
      const lanes = await Promise.all(Array.from({ length: 10 }, async () => {
        const registry = new RecordingRegistry();
        const host = new RecordingHost();
        const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 20 });
        return { registry, host, stop };
      }));

      for (let eventCursor = 1; eventCursor <= 100; eventCursor += 1) {
        for (const lane of lanes) lane.host.emit({ eventCursor });
      }

      expect(lanes.reduce((sum, lane) => sum + lane.registry.writes.length, 0)).toBe(10);
      await Bun.sleep(35);
      expect(lanes.reduce((sum, lane) => sum + lane.registry.writes.length, 0)).toBe(20);
      expect(lanes.every((lane) => lane.registry.writes.at(-1)?.columns.eventCursor === 100)).toBeTrue();
      for (const lane of lanes) lane.stop();
    });

    test("coalesces cursor-only events into one trailing registry mutation", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 20 });

      for (let eventCursor = 1; eventCursor <= 20; eventCursor += 1) host.emit({ eventCursor });

      expect(registry.writes).toHaveLength(1);
      await Bun.sleep(35);
      expect(registry.writes).toHaveLength(2);
      expect(registry.writes.at(-1)?.columns.eventCursor).toBe(20);
      stop();
    });

    test("persists material and terminal changes immediately with the latest cursor", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 100 });

      host.emit({ eventCursor: 1 });
      host.emit({ eventCursor: 2, status: "active", activeTurnRef: "turn-1" });
      expect(registry.writes).toHaveLength(2);
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 2, activeTurnRef: "turn-1" },
        status: "live",
      });

      host.emit({ eventCursor: 3, status: "attention", pendingAttention: ["approval-1"] });
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 3, pendingAttention: ["approval-1"] },
        status: "live",
      });
      host.emit({ eventCursor: 4, status: "active", pendingAttention: [], activeFlags: ["waiting"] });
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 4, activeFlags: ["waiting"] },
        status: "live",
      });
      host.emit({ eventCursor: 5 });
      host.emit({
        eventCursor: 6,
        status: "unhosted",
        endpoint: "stdio:released",
        pid: null,
        processStartIdentity: null,
        activeTurnRef: null,
      });
      expect(registry.writes).toHaveLength(5);
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 6, process: null },
        status: "unhosted",
        releaseClaim: true,
      });
      await Bun.sleep(120);
      expect(registry.writes).toHaveLength(5);
    });

    test("flushes the newest cursor before an explicit persistence stop", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 100 });

      host.emit({ eventCursor: 8 });
      host.emit({ eventCursor: 9 });
      stop();

      expect(registry.writes.map((write) => write.columns.eventCursor)).toEqual([0, 9]);
      expect(registry.releases).toEqual([7]);
      await Bun.sleep(120);
      expect(registry.writes).toHaveLength(2);
    });

    test("releases the host when a trailing write loses its claim", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 10 });

      registry.acceptWrites = false;
      host.emit({ eventCursor: 1 });
      await Bun.sleep(25);

      expect(host.releaseCalls).toBe(1);
      expect(registry.releases).toEqual([7]);
    });
  });
}
