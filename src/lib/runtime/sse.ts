import type { RuntimeHostClient } from "./client";
import type { RuntimeEvent } from "./contracts";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;

export function runtimeCursor(queryValue: string | null, lastEventId: string | null): number {
  const values = [queryValue, lastEventId].filter((value): value is string => value !== null && value !== "");
  const cursors = values.map(Number);
  if (cursors.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("cursor must be a non-negative sequence");
  return cursors.length ? Math.max(...cursors) : 0;
}

function messageFrame(data: unknown, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

function controlFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE blocks on the runtime-host waiter and pulls one bounded replay batch at a time. */
export function runtimeEventStream(client: RuntimeHostClient, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  let cursor = after;
  let stopped = false;
  let pulling = false;
  signal.addEventListener("abort", () => { stopped = true; }, { once: true });
  return new ReadableStream({
    async pull(controller) {
      if (stopped || pulling) return;
      pulling = true;
      try {
        const replay = await client.waitEvents(cursor, HEARTBEAT_MS, signal);
        if (stopped) return;
        if (replay.reset) {
          controller.enqueue(encoder.encode(controlFrame("reset", { floorSeq: replay.floorSeq })));
          stopped = true;
          controller.close();
          return;
        }
        if (replay.events.length > 0) {
          const frames: string[] = [];
          for (const event of replay.events) {
            frames.push(messageFrame(event, event.seq));
            cursor = event.seq;
          }
          controller.enqueue(encoder.encode(frames.join("")));
        } else {
          controller.enqueue(encoder.encode(`: heartbeat published=${cursor}\n${controlFrame("heartbeat", { publishedSeq: cursor })}`));
        }
      } catch {
        if (!stopped) {
          controller.enqueue(encoder.encode(controlFrame("fault", { code: "runtime-host-unavailable" })));
          stopped = true;
          controller.close();
        }
      } finally {
        pulling = false;
      }
    },
    cancel() {
      stopped = true;
    },
  });
}

export function runtimeEventFromJson(value: unknown): RuntimeEvent | null {
  return value && typeof value === "object" && typeof (value as { seq?: unknown }).seq === "number" ? value as RuntimeEvent : null;
}
