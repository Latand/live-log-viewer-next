import { conversationEntryForPath } from "@/lib/scanner/conversationEntry";

import { tickFlowById } from "./engine";
import { loadFlows } from "./store";

type FlowTick = (id: string) => Promise<void>;

interface FlowSignalState {
  pending: Set<string>;
  draining: boolean;
  tick: FlowTick;
}

const signalHost = globalThis as typeof globalThis & {
  __llvFlowSignal?: FlowSignalState;
};

async function tickCurrentFlow(id: string): Promise<void> {
  const flow = loadFlows().find((candidate) => candidate.id === id);
  if (!flow) return;
  const entry = conversationEntryForPath(flow.implementerPath);
  if (!entry) return;
  await tickFlowById(id, [entry]);
}

const signal = signalHost.__llvFlowSignal ??= {
  pending: new Set<string>(),
  draining: false,
  tick: tickCurrentFlow,
};

async function drain(): Promise<void> {
  if (signal.draining) return;
  signal.draining = true;
  try {
    while (signal.pending.size > 0) {
      const ids = [...signal.pending];
      signal.pending.clear();
      for (const id of ids) {
        try {
          await signal.tick(id);
        } catch {
          console.error(`[flow controller] requested tick failed for ${id}`);
        }
      }
    }
  } finally {
    signal.draining = false;
  }
}

/** Coalesces route-triggered progress while preserving the durable flow state. */
export function requestFlowTick(id: string): void {
  signal.pending.add(id);
  queueMicrotask(() => void drain());
}

/** Test seam for the scheduling contract. */
export function registerFlowTick(tick: FlowTick): () => void {
  const previous = signal.tick;
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = previous;
  };
}
