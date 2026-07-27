import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

/**
 * The ambient lease, driven the way React actually drives it.
 *
 * The operator moves between conversation cards all day. Each card's composer is
 * its own mount with its own lease, and the switch mounts the next one before
 * unmounting the last — so the thing under test is that the background music
 * never notices. Nothing here is mocked: the real lease, the real ownership set
 * and the real loop controller, on a fake transport.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});

const { useAmbientCallLease } = await import("./useCodexRealtime");
const { ambientLoop, configureAmbientTransportForTests, resetAppAudioForTests } = await import("@/lib/audio/app");
const { configureAudioPrefsStorage, setAudioPrefs } = await import("@/lib/audio/prefs");
const { FADE_OUT_SECONDS } = await import("@/lib/audio/ambientLoop");

import type { LoopTransport, LoopVoiceHandle } from "@/lib/audio/ambientLoop";

function fakeTransport() {
  const starts: { gain: number; offsetSeconds?: number }[] = [];
  const pauses: number[] = [];
  const stops: number[] = [];
  const transport: LoopTransport = {
    start(request) {
      starts.push({ gain: request.gain, offsetSeconds: request.offsetSeconds });
      const handle: LoopVoiceHandle = {
        rampTo: () => undefined,
        pause: (seconds) => {
          pauses.push(seconds);
          return 12;
        },
        stop: (seconds) => void stops.push(seconds),
      };
      return handle;
    },
  };
  return { transport, starts, pauses, stops };
}

/** One conversation card's composer, reduced to the part that owns the lease. */
function Card({ live }: { live: boolean }) {
  useAmbientCallLease(live);
  return null;
}

let sink: ReturnType<typeof fakeTransport>;
const roots: Root[] = [];

beforeEach(() => {
  const values = new Map<string, string>();
  configureAudioPrefsStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  });
  resetAppAudioForTests();
  sink = fakeTransport();
  configureAmbientTransportForTests(sink.transport);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  resetAppAudioForTests();
  configureAudioPrefsStorage(undefined);
});

async function mount(live: boolean) {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Card live={live} />));
  return {
    async setLive(next: boolean) {
      await act(async () => root.render(<Card live={next} />));
    },
    async unmount() {
      roots.splice(roots.indexOf(root), 1);
      await act(async () => root.unmount());
    },
  };
}

describe("music during calls only", () => {
  test("switching cards mid-call neither restarts nor drops the track", async () => {
    setAudioPrefs({ loopEnabled: true });

    const cardA = await mount(true);
    expect(sink.starts).toHaveLength(1);

    /* The next card's composer mounts while the first is still mounted, which is
       the order React unmounts and mounts in on a re-key. */
    const cardB = await mount(true);
    await cardA.unmount();

    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);

    /* The last card leaving is what ends it, and it fades. */
    await cardB.setLive(false);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
    expect(ambientLoop().state().playing).toBe(false);
  });
});

describe("music in the Viewer and during calls", () => {
  test("the call boundary is inaudible in both directions", async () => {
    setAudioPrefs({ loopEnabled: true, viewerLoopEnabled: true });

    /* Music is already playing before any composer mounts. */
    expect(sink.starts).toHaveLength(1);

    const card = await mount(false);
    await card.setLive(true);
    await card.setLive(false);
    await card.unmount();

    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);
    expect(ambientLoop().state().resumeAt).toBe(0);
  });
});
