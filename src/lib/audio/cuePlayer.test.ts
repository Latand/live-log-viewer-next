import { beforeEach, describe, expect, test } from "bun:test";

import { createCuePlayer, type CueStartRequest, type CueTransport } from "./cuePlayer";
import { cueAsset, type AudioCue } from "./cues";

/** A transport that records what it was asked to play and can refuse, the way a
    locked audio graph does. */
function recorder(options: { refuse?: boolean } = {}) {
  const started: CueStartRequest[] = [];
  const stopped: AudioCue[] = [];
  const ended: (() => void)[] = [];
  const transport: CueTransport = {
    start(request) {
      if (options.refuse) return null;
      started.push(request);
      ended.push(request.onEnded);
      return { stop: () => stopped.push(request.cue) };
    },
  };
  return {
    transport,
    started,
    stopped,
    /** Let the n-th started voice finish, as the audio graph would. */
    finish(index: number) {
      ended[index]?.();
    },
    cues: () => started.map((request) => request.cue),
  };
}

const prefs = { cuesEnabled: true, cueVolume: 1 };
let device: typeof prefs;

beforeEach(() => {
  device = { ...prefs };
});

function player(sink: ReturnType<typeof recorder>) {
  return createCuePlayer({ transport: sink.transport, prefs: () => device });
}

describe("de-duplication on a stable event identity", () => {
  test("one logical event plays once, however many times it is observed", () => {
    const sink = recorder();
    const cues = player(sink);

    /* A 4s attention poll, a re-render, and a reconnect replay all report the
       same request id. */
    expect(cues.play({ cue: "attention", eventId: "attention:req-7" })).toBe("played");
    expect(cues.play({ cue: "attention", eventId: "attention:req-7" })).toBe("deduped");
    expect(cues.play({ cue: "attention", eventId: "attention:req-7" })).toBe("deduped");

    expect(sink.started).toHaveLength(1);
  });

  test("different logical events with the same cue both play", () => {
    const sink = recorder();
    const cues = player(sink);

    cues.play({ cue: "failure", eventId: "launch-failed:a" });
    cues.play({ cue: "failure", eventId: "launch-failed:b" });

    expect(sink.cues()).toEqual(["failure", "failure"]);
  });

  test("a blocked event is spent, so nothing floods out after the unlock", () => {
    const locked = recorder({ refuse: true });
    const cues = createCuePlayer({ transport: locked.transport, prefs: () => device });
    expect(cues.play({ cue: "success", eventId: "lifecycle:success:/a:1" })).toBe("blocked");

    /* Same player, transport now willing: the event is history, not a backlog. */
    const open = recorder();
    const later = createCuePlayer({ transport: open.transport, prefs: () => device });
    expect(cues.play({ cue: "success", eventId: "lifecycle:success:/a:1" })).toBe("deduped");
    /* And a genuinely new transition of the same conversation still rings. */
    expect(later.play({ cue: "success", eventId: "lifecycle:success:/a:2" })).toBe("played");
    expect(open.started).toHaveLength(1);
  });

  test("the identity memory is bounded and evicts the oldest first", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, dedupeCapacity: 3 });

    for (const id of ["e1", "e2", "e3", "e4"]) cues.play({ cue: "tool-tick", eventId: id });
    /* e1 was evicted by e4, so it is playable again; e4 is still remembered. */
    expect(cues.play({ cue: "tool-tick", eventId: "e4" })).toBe("deduped");
    expect(cues.play({ cue: "tool-tick", eventId: "e1" })).not.toBe("deduped");
  });
});

describe("bounded overlap", () => {
  test("a burst of tool ticks is bounded by the overlap cap", () => {
    const sink = recorder();
    const cues = player(sink);

    for (let index = 0; index < 20; index += 1) {
      cues.play({ cue: "tool-tick", eventId: `tool:conv:call-${index}`, delayMs: index * 220 });
    }

    expect(sink.started).toHaveLength(3);
    expect(cues.activeVoices()).toHaveLength(3);
  });

  test("each newly appended call earns exactly one sound when cap allows", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 10 });

    cues.play({ cue: "tool-tick", eventId: "tool:conv:a" });
    cues.play({ cue: "tool-tick", eventId: "tool:conv:b", delayMs: 220 });
    cues.play({ cue: "viewer-mcp", eventId: "tool:conv:c", delayMs: 440 });

    expect(sink.started).toHaveLength(3);
    expect(sink.started.map((r) => r.cue)).toEqual(["tool-tick", "tool-tick", "viewer-mcp"]);
  });

  test("a tick after the previous one finished plays again", () => {
    const sink = recorder();
    const cues = player(sink);

    cues.play({ cue: "tool-tick", eventId: "tool:conv:1" });
    sink.finish(0);
    cues.play({ cue: "tool-tick", eventId: "tool:conv:2" });

    expect(sink.started).toHaveLength(2);
  });

  test("simultaneous voices never exceed the cap", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 3 });

    cues.play({ cue: "success", eventId: "s1" });
    cues.play({ cue: "success", eventId: "s2" });
    cues.play({ cue: "launch", eventId: "l1" });
    expect(cues.activeVoices()).toHaveLength(3);

    /* A fourth salient cue has nothing weaker to displace: dropped outright,
       never queued. */
    expect(cues.play({ cue: "launch", eventId: "l2" })).toBe("dropped");
    expect(cues.activeVoices()).toHaveLength(3);
    expect(sink.started).toHaveLength(3);
  });

  test("at the cap, priority news displaces routine texture", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 2 });

    cues.play({ cue: "tool-tick", eventId: "t1" });
    cues.play({ cue: "viewer-mcp", eventId: "m1" });
    expect(cues.activeVoices()).toEqual(["tool-tick", "viewer-mcp"]);

    expect(cues.play({ cue: "failure", eventId: "f1" })).toBe("played");
    /* The quieter of the two routine voices was stopped, not the failure held. */
    expect(sink.stopped).toEqual(["tool-tick"]);
    expect(cues.activeVoices()).toEqual(["viewer-mcp", "failure"]);
  });

  test("routine cues never displace each other at the cap", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 1 });

    cues.play({ cue: "viewer-mcp", eventId: "m1" });
    expect(cues.play({ cue: "tool-tick", eventId: "t1" })).toBe("dropped");
    expect(sink.stopped).toEqual([]);
  });
});

describe("the loudness hierarchy", () => {
  test("priority cues are never quieter than routine ones", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 99 });

    for (const cue of ["attention", "failure", "launch", "success", "viewer-mcp", "tool-tick"] as const) {
      cues.play({ cue, eventId: `one-of-each:${cue}` });
      sink.finish(sink.started.length - 1);
    }
    const gainOf = (cue: AudioCue) => sink.started.find((request) => request.cue === cue)!.gain;

    expect(gainOf("attention")).toBe(gainOf("failure"));
    expect(gainOf("attention")).toBeGreaterThan(gainOf("launch"));
    expect(gainOf("launch")).toBe(gainOf("success"));
    expect(gainOf("success")).toBeGreaterThan(gainOf("viewer-mcp"));
    expect(gainOf("viewer-mcp")).toBe(gainOf("tool-tick"));
    /* And every cue plays its own bundled master, at the tier gain — nothing
       re-levels the file itself. */
    expect(sink.started.map((request) => request.src)).toEqual([
      cueAsset("attention"), cueAsset("failure"), cueAsset("launch"),
      cueAsset("success"), cueAsset("viewer-mcp"), cueAsset("tool-tick"),
    ]);
  });

  test("the device volume scales every tier and keeps the ordering", () => {
    const sink = recorder();
    device.cueVolume = 0.4;
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 99 });

    cues.play({ cue: "attention", eventId: "a" });
    cues.play({ cue: "tool-tick", eventId: "t" });

    const [priority, routine] = sink.started;
    expect(priority.gain).toBeCloseTo(0.4, 5);
    expect(routine.gain).toBeCloseTo(0.2, 5);
    expect(priority.gain).toBeGreaterThan(routine.gain);
  });
});

describe("degradation and settings", () => {
  test("a device with cues muted plays nothing and throws nothing", () => {
    const sink = recorder();
    device.cuesEnabled = false;
    const cues = player(sink);

    expect(cues.play({ cue: "attention", eventId: "a1" })).toBe("disabled");
    expect(sink.started).toEqual([]);
  });

  test("an autoplay-locked device degrades silently, event after event", () => {
    const locked = recorder({ refuse: true });
    const cues = createCuePlayer({ transport: locked.transport, prefs: () => device });

    for (let index = 0; index < 5; index += 1) {
      expect(cues.play({ cue: "tool-tick", eventId: `t${index}` })).toBe("blocked");
    }
    /* Nothing wedged: no voice is left registered against the cap. */
    expect(cues.activeVoices()).toEqual([]);
  });

  test("a priority cue notifies the bed, routine texture does not", () => {
    const sink = recorder();
    const ducked: AudioCue[] = [];
    const cues = createCuePlayer({
      transport: sink.transport,
      prefs: () => device,
      onPriorityCue: (cue) => ducked.push(cue),
    });

    cues.play({ cue: "attention", eventId: "a" });
    cues.play({ cue: "tool-tick", eventId: "t" });
    cues.play({ cue: "failure", eventId: "f" });

    expect(ducked).toEqual(["attention", "failure"]);
  });

  test("several cues from one poll cascade rather than sounding as a chord", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 99 });

    cues.play({ cue: "success", eventId: "s1", delayMs: 0 });
    cues.play({ cue: "success", eventId: "s2", delayMs: 220 });
    cues.play({ cue: "success", eventId: "s3", delayMs: 440 });

    expect(sink.started.map((request) => request.delaySeconds)).toEqual([0, 0.22, 0.44]);
    /* Staggered but already counted: a delay cannot smuggle voices past the cap. */
    expect(cues.activeVoices()).toHaveLength(3);
  });

  test("pan is passed through and clamped to the stereo field", () => {
    const sink = recorder();
    const cues = createCuePlayer({ transport: sink.transport, prefs: () => device, maxConcurrent: 99 });

    cues.play({ cue: "success", eventId: "s1", pan: -0.5 });
    cues.play({ cue: "launch", eventId: "s2", pan: 4 });

    expect(sink.started.map((request) => request.pan)).toEqual([-0.5, 1]);
  });
});
