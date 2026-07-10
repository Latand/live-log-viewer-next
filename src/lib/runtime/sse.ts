import type { RuntimeHostClient } from "./client";
import type { RuntimeEvent } from "./contracts";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;
const POLL_MS = 750;

function frame(event: string, data: unknown, id?: number): Uint8Array {
  return encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** SSE is a read-only bridge over the socket protocol. Heartbeats never allocate journal sequence values. */
export function runtimeEventStream(client: RuntimeHostClient, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let cursor = after;
      let stopped = false;
      let lastHeartbeat = Date.now();
      const stop = () => { stopped = true; clearInterval(timer); };
      const tick = async () => {
        if (stopped) return;
        try {
          const replay = await client.events(cursor);
          if (replay.reset) {
            controller.enqueue(frame("reset", { floorSeq: replay.floorSeq }));
            cursor = replay.floorSeq;
            return;
          }
          for (const event of replay.events) {
            controller.enqueue(frame("runtime", event, event.seq));
            cursor = event.seq;
          }
          if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastHeartbeat = Date.now();
          }
        } catch {
          controller.enqueue(frame("fault", { code: "runtime-host-unavailable" }));
          stop();
          controller.close();
        }
      };
      const timer = setInterval(() => void tick(), POLL_MS);
      signal.addEventListener("abort", stop, { once: true });
      void tick();
    },
  });
}

export function runtimeEventFromJson(value: unknown): RuntimeEvent | null {
  return value && typeof value === "object" && typeof (value as { seq?: unknown }).seq === "number" ? value as RuntimeEvent : null;
}
