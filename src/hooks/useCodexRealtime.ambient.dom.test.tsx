import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

/**
 * The ambient lease, driven the way React actually drives it.
 *
 * The operator moves between conversation cards all day, and the focused card is
 * a KEYED element (`MobileFocusView` keys its pane by conversation path). React
 * replaces a keyed subtree by destroying the old one's effects and only then
 * creating the new one's — cleanup first, in the same commit — so for one
 * instant nobody holds a lease. That instant is what this file exists to prove
 * the background music never hears. Nothing is mocked: the real lease, the real
 * ownership set and the real loop controller, on a fake transport.
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

const { configureRealtimeClientForTests, useAmbientCallLease, useCodexRealtime } = await import("./useCodexRealtime");
const { ambientLoop, configureAmbientTransportForTests, resetAppAudioForTests } = await import("@/lib/audio/app");
const { configureAudioPrefsStorage, setAudioPrefs } = await import("@/lib/audio/prefs");
const { FADE_OUT_SECONDS, loopGain, SPEECH_DUCK } = await import("@/lib/audio/ambientLoop");

import type { ReactNode } from "react";

import type { LoopTransport, LoopVoiceHandle } from "@/lib/audio/ambientLoop";
import type { CodexRealtimeSnapshot } from "@/lib/realtime/codexRealtimeClient";

import type { RealtimeSurface } from "./useCodexRealtime";

function fakeTransport() {
  const starts: { gain: number; offsetSeconds?: number }[] = [];
  const ramps: { gain: number; seconds: number }[] = [];
  const pauses: number[] = [];
  const stops: number[] = [];
  const transport: LoopTransport = {
    start(request) {
      starts.push({ gain: request.gain, offsetSeconds: request.offsetSeconds });
      const handle: LoopVoiceHandle = {
        rampTo: (gain, seconds) => void ramps.push({ gain, seconds }),
        pause: (seconds) => {
          pauses.push(seconds);
          return 12;
        },
        resume: () => true,
        stop: (seconds) => void stops.push(seconds),
      };
      return handle;
    },
  };
  return { transport, starts, ramps, pauses, stops, last: () => ramps.at(-1) };
}

const IDLE: CodexRealtimeSnapshot = {
  phase: "idle",
  lines: [],
  error: null,
  startedAt: null,
  micMuted: false,
  outputMuted: false,
};

/**
 * A realtime surface with no WebRTC under it.
 *
 * Only the transport is replaced. The snapshot it publishes is the one the real
 * client publishes — the same `lines`, marked non-final while somebody is
 * talking and final when they stop — so everything the hook does with it is
 * under test.
 */
function fakeClient() {
  const clients = new Map<string, RealtimeSurface & { push(patch: Partial<CodexRealtimeSnapshot>): void }>();
  const factory = (conversationId: string) => {
    const existing = clients.get(conversationId);
    if (existing) return existing;
    let snapshot: CodexRealtimeSnapshot = IDLE;
    const listeners = new Set<() => void>();
    const client = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      micStream: () => null,
      toggleMic: () => undefined,
      toggleOutput: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      updateWorkerProgress: () => undefined,
      reconcileWorkerDeliveries: () => undefined,
      push(patch: Partial<CodexRealtimeSnapshot>) {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
      },
    };
    clients.set(conversationId, client);
    return client;
  };
  return { factory, of: (conversationId: string) => factory(conversationId) };
}

const line = (role: "user" | "assistant" | "progress", text: string, final: boolean, id: string = role) => ({ id, role, text, final });

/** One conversation card's composer, reduced to the part that owns the lease. */
function Card({ live }: { live: boolean }) {
  useAmbientCallLease(live);
  return null;
}

/**
 * The focus view: exactly one card on screen, keyed by conversation.
 *
 * The `key` is the whole point — it is what makes React tear the old card down
 * and build the new one instead of re-rendering the same instance, and it is
 * what `MobileFocusView` does.
 */
function FocusView({ card, live }: { card: string; live: boolean }) {
  return <Card key={card} live={live} />;
}

let sink: ReturnType<typeof fakeTransport>;
let realtime: ReturnType<typeof fakeClient>;
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
  realtime = fakeClient();
  configureRealtimeClientForTests(realtime.factory);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  resetAppAudioForTests();
  configureRealtimeClientForTests(null);
  configureAudioPrefsStorage(undefined);
});

/** One React root, rendered into repeatedly — the production renderer. */
function screen() {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.push(root);
  return {
    async show(node: ReactNode) {
      await act(async () => root.render(node));
    },
    async close() {
      roots.splice(roots.indexOf(root), 1);
      await act(async () => root.unmount());
    },
  };
}

describe("music during calls only", () => {
  test("a keyed card switch mid-call neither restarts nor drops the track", async () => {
    setAudioPrefs({ loopEnabled: true });
    const view = screen();

    await view.show(<FocusView card="conversation-a" live />);
    expect(sink.starts).toHaveLength(1);

    /* The operator swipes to the next conversation. React destroys card A's
       effects and only then creates card B's, so the lease count touches zero
       in between — and the music must not hear that. */
    await view.show(<FocusView card="conversation-b" live />);

    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);

    /* The call genuinely ending is still what ends it, and it fades. */
    await view.show(<FocusView card="conversation-b" live={false} />);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
    expect(ambientLoop().state().playing).toBe(false);
  });

  test("a card leaving cannot end a call another mounted card is still holding", async () => {
    setAudioPrefs({ loopEnabled: true });
    const view = screen();

    /* Two composers mounted at once — the desktop board, where cards sit side
       by side. Each lease is its own. */
    await view.show(<><Card key="a" live /><Card key="b" live /></>);
    expect(sink.starts).toHaveLength(1);

    await view.show(<><Card key="a" live={false} /><Card key="b" live /></>);
    expect(sink.pauses).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);

    await view.show(<><Card key="a" live={false} /><Card key="b" live={false} /></>);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
  });

  test("closing the last card ends the call side of the music", async () => {
    setAudioPrefs({ loopEnabled: true });
    const view = screen();

    await view.show(<FocusView card="conversation-a" live />);
    await view.close();

    /* Unmounting for good is not a handoff: nothing took the lease over. */
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
    expect(ambientLoop().state().playing).toBe(false);
  });
});

/**
 * Ducking, end to end from the transcript the call already produces.
 *
 * The composer never tells the music who is talking; the transcript does. These
 * tests drive `useCodexRealtime` itself — the same hook the composer mounts —
 * and assert the gain the bed is actually asked for, so a wiring that never
 * reaches the loop controller fails here however well the controller behaves on
 * its own.
 */
describe("ducking under whoever is talking", () => {
  /** The full composer surface, exactly as a conversation card mounts it. */
  function Composer({ id }: { id: string }) {
    useCodexRealtime(id, true, "", "", false, []);
    return null;
  }

  const FULL = loopGain(1);
  const DUCKED = FULL * SPEECH_DUCK;

  test("a non-final transcript line ducks the music, and its final line releases it", async () => {
    setAudioPrefs({ loopEnabled: true, loopVolume: 1 });
    const view = screen();
    await view.show(<Composer id="conversation_a" />);
    const client = realtime.of("conversation_a");

    await act(async () => client.push({ phase: "live" }));
    expect(sink.starts).toHaveLength(1);
    expect(sink.last()!.gain).toBeCloseTo(FULL, 6);

    /* The agent starts talking: the wire says so by streaming a non-final line. */
    await act(async () => client.push({ lines: [line("assistant", "I think", false)] }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);
    expect(sink.last()!.seconds).toBeGreaterThan(0);
    expect(ambientLoop().state().ducked).toBe(true);

    /* It stops talking: the same line is marked final. */
    await act(async () => client.push({ lines: [line("assistant", "I think so.", true)] }));
    expect(sink.last()!.gain).toBeCloseTo(FULL, 6);
    expect(ambientLoop().state().ducked).toBe(false);

    /* And the operator's own voice ducks it just the same. */
    await act(async () => client.push({
      lines: [line("assistant", "I think so.", true, "a"), line("user", "wait", false, "b")],
    }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);
  });

  test("relayed worker progress is text, not a voice: it never ducks the music", async () => {
    setAudioPrefs({ loopEnabled: true, loopVolume: 1 });
    const view = screen();
    await view.show(<Composer id="conversation_a" />);
    const client = realtime.of("conversation_a");

    await act(async () => client.push({ phase: "live" }));
    await act(async () => client.push({
      lines: [line("assistant", "on it", true, "a"), line("progress", "worker: still building", false, "b")],
    }));

    expect(sink.last()!.gain).toBeCloseTo(FULL, 6);
    expect(ambientLoop().state().ducked).toBe(false);
  });

  test("hanging up releases the duck even if the last line never went final", async () => {
    setAudioPrefs({ loopEnabled: true, viewerLoopEnabled: true, loopVolume: 1 });
    const view = screen();
    await view.show(<Composer id="conversation_a" />);
    const client = realtime.of("conversation_a");

    await act(async () => client.push({ phase: "live" }));
    await act(async () => client.push({ lines: [line("assistant", "mid-sentence", false)] }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);

    /* A call that drops mid-sentence leaves a non-final line behind for good. The
       music must not stay held down under a voice that is gone. */
    await act(async () => client.push({ phase: "idle" }));
    expect(sink.last()!.gain).toBeCloseTo(FULL, 6);
    expect(ambientLoop().state().ducked).toBe(false);
    expect(ambientLoop().state().playing).toBe(true);
  });

  test("a line left non-final by a finished call cannot duck the next one", async () => {
    setAudioPrefs({ loopEnabled: true, loopVolume: 1 });
    const view = screen();
    await view.show(<Composer id="conversation_a" />);
    const client = realtime.of("conversation_a");

    /* A call that ends mid-sentence. The client never marks that line final —
       neither `start()` nor `stop()` touches `lines`, and the transcript is
       deliberately kept on screen after a hangup — so it is still sitting there,
       still non-final, when the next call opens. */
    await act(async () => client.push({ phase: "live", startedAt: 1 }));
    await act(async () => client.push({ lines: [line("assistant", "mid-sentence", false, "assistant:1")] }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);

    await act(async () => client.push({ phase: "idle" }));
    expect(ambientLoop().state().ducked).toBe(false);

    const before = sink.ramps.length;
    await act(async () => client.push({ phase: "live", startedAt: 2 }));

    /* Not "ducked and then released": never ducked at all. A new call opens with
       nobody talking in it, whatever the last one left behind. */
    expect(ambientLoop().state().ducked).toBe(false);
    expect(sink.ramps.slice(before).filter((ramp) => ramp.gain < FULL - 1e-9)).toEqual([]);
    expect(sink.last()!.gain).toBeCloseTo(FULL, 6);

    /* And the new call's own voice still ducks it: the guard is scoped to the
       lines that came before it, not to the feature. */
    await act(async () => client.push({
      lines: [
        line("assistant", "mid-sentence", false, "assistant:1"),
        line("assistant", "new turn", false, "assistant:2"),
      ],
    }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);
  });

  test("a silent card cannot release the duck the talking card is holding", async () => {
    setAudioPrefs({ loopEnabled: true, loopVolume: 1 });
    const view = screen();
    await view.show(<><Composer id="conversation_a" /><Composer id="conversation_b" /></>);
    const talking = realtime.of("conversation_a");
    const quiet = realtime.of("conversation_b");

    await act(async () => talking.push({ phase: "live" }));
    await act(async () => quiet.push({ phase: "live" }));
    await act(async () => talking.push({ lines: [line("assistant", "listening", false)] }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);

    /* The other call re-renders with nobody talking in it. That says nothing
       about the card that IS talking. */
    await act(async () => quiet.push({ lines: [line("user", "hello", true)] }));
    expect(sink.last()!.gain).toBeCloseTo(DUCKED, 6);
    expect(ambientLoop().state().ducked).toBe(true);

    /* Only the talking card falling silent releases it. */
    await act(async () => talking.push({ lines: [line("assistant", "listening.", true)] }));
    expect(sink.last()!.gain).toBeCloseTo(FULL, 6);
  });
});

describe("music in the Viewer and during calls", () => {
  test("the call boundary is inaudible in both directions", async () => {
    setAudioPrefs({ loopEnabled: true, viewerLoopEnabled: true });

    /* Music is already playing before any composer mounts. */
    expect(sink.starts).toHaveLength(1);

    const view = screen();
    await view.show(<FocusView card="conversation-a" live={false} />);
    await view.show(<FocusView card="conversation-a" live />);
    await view.show(<FocusView card="conversation-b" live />);
    await view.show(<FocusView card="conversation-b" live={false} />);
    await view.close();

    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);
    expect(ambientLoop().state().resumeAt).toBe(0);
  });
});
