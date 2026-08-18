import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";
import { MAX_CHUNK_CHARS } from "@/lib/ttsChunks";

import { SpeakButton } from "./SpeakButton";
import { clearTtsCache, evictTtsAudio } from "./ttsSession";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Text: dom.Text,
  Range: dom.Range,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

/** The CSS Custom Highlight API, which happy-dom does not ship. */
class FakeHighlight {
  ranges: Range[] = [];
  add(range: Range) { this.ranges.push(range); }
  clear() { this.ranges = []; }
}
const highlights = new Map<string, FakeHighlight>();
Object.assign(globalThis, { Highlight: FakeHighlight, CSS: { highlights } });

const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const backendInfo = {
  backend: "openai",
  lockedByEnv: false,
  options: [
    { id: "openai", available: true, keyPath: "/keys/openai", model: "gpt-4o-mini-tts", voice: "alloy", cap: 4000 },
    { id: "elevenlabs", available: false, keyPath: "/keys/elevenlabs", model: "eleven_multilingual_v2", voice: "Rachel", cap: 4000 },
  ],
};

/**
 * Audio that refuses to play until a muted silent clip has carried the user
 * gesture into it — the autoplay policy the Speak control works around, now
 * across a whole sequence of chunks instead of one clip.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  muted = false;
  src = "";
  currentTime = 0;
  duration = 10;
  paused = true;
  private unlocked = false;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = "") {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  load() {}
  pause() { this.paused = true; }
  async play() {
    if (this.muted && this.src.startsWith("data:audio/wav")) this.unlocked = true;
    if (!this.unlocked) throw new DOMException("blocked", "NotAllowedError");
    this.paused = false;
    this.onloadedmetadata?.();
  }
  tick(time: number) { this.currentTime = time; this.ontimeupdate?.(); }
  finish() { this.currentTime = this.duration; this.paused = true; this.onended?.(); }
}

function useFakeAudio(): void {
  FakeAudio.instances = [];
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
}

/** The element a chunk is playing on, if any. */
function playing(): FakeAudio | undefined {
  return FakeAudio.instances.find((element) => !element.paused && element.src.startsWith("blob:"));
}

async function drainUpdates(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function mount(text: string): Promise<{ button: HTMLButtonElement; root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<SpeakButton text={text} />); });
  await drainUpdates();
  return { button: host.querySelector("button")!, root, host };
}

/** The Speak control inside the feed markup that carries the rendered answer. */
async function mountInFeed(text: string): Promise<{ button: HTMLButtonElement; root: Root; host: HTMLDivElement; body: HTMLElement }> {
  const host = document.createElement("div");
  host.setAttribute("data-feed-kind", "prose");
  document.body.append(host);
  const controls = document.createElement("div");
  controls.setAttribute("data-tts-message", "");
  const slot = document.createElement("span");
  const body = document.createElement("div");
  body.setAttribute("data-tts-body", "");
  body.append(document.createTextNode(text));
  controls.append(slot, body);
  host.append(controls);
  const root = createRoot(slot);
  flushSync(() => { root.render(<SpeakButton text={text} />); });
  await drainUpdates();
  return { button: slot.querySelector("button")!, root, host, body };
}

async function confirm(view: { host: HTMLElement; button: HTMLButtonElement }): Promise<void> {
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  const speak = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  flushSync(() => { speak.click(); });
  await drainUpdates();
}

const LONG = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} of a long agent answer that must be voiced in full.`).join(" ");

beforeEach(() => {
  clearTtsCache();
  highlights.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Audio = originalAudio;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.body.replaceChildren();
});

test("a second click cancels pending synthesis and ignores its stale response", async () => {
  let resolvePost!: (response: Response) => void;
  let postSignal: AbortSignal | undefined;
  let configRequests = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) { configRequests += 1; return Response.json(backendInfo); }
    postSignal = init.signal as AbortSignal;
    return new Promise<Response>((resolve) => { resolvePost = resolve; });
  }) as unknown as typeof fetch;
  const createObjectURL = mock(() => "blob:tts");
  URL.createObjectURL = createObjectURL;
  useFakeAudio();

  const view = await mount("Read me");
  const other = await mount("Another answer");
  expect(configRequests).toBe(1);
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(view.host.textContent).toContain("Billed to your openai account per character");
  expect(view.host.textContent).toContain("AI-generated voice");
  expect(postSignal).toBeUndefined();
  const speak = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  flushSync(() => { speak.click(); });
  await drainUpdates();
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(postSignal?.aborted).toBe(true);

  resolvePost(new Response(new Blob(["late"])));
  await drainUpdates();
  expect(createObjectURL).not.toHaveBeenCalled();
  flushSync(() => { view.root.unmount(); });
  flushSync(() => { other.root.unmount(); });
  view.host.remove();
  other.host.remove();
});

test("a long answer is chunked, synthesized in parallel and played from the first chunk", async () => {
  const sent: string[] = [];
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    sent.push(text);
    return new Promise<Response>((resolve) => pending.set(text, resolve));
  }) as unknown as typeof fetch;
  URL.createObjectURL = mock((blob: Blob) => `blob:${(blob as Blob & { id?: string }).id ?? "chunk"}`);
  useFakeAudio();

  const view = await mount(LONG);
  await confirm(view);

  /* Two chunks are in flight at once, and neither covers the whole message. */
  expect(sent.length).toBe(2);
  for (const text of sent) expect(text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  expect(playing()).toBeUndefined();

  /* The first chunk alone starts the voice; the rest are still synthesizing. */
  pending.get(sent[0]!)!(new Response(new Blob(["audio-0"])));
  await drainUpdates();
  expect(playing()).toBeDefined();
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  expect(pending.has(sent[1]!)).toBe(true);

  for (const [text, resolve] of [...pending]) {
    resolve(new Response(new Blob([`audio-${text.length}`])));
    await drainUpdates();
  }

  /* Nothing was truncated: the chunks reassemble the whole answer. */
  expect(sent.join(" ")).toBe(LONG);
  expect(sent.length).toBeGreaterThan(2);
  expect(view.host.querySelector('[role="alert"]')).toBeNull();
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

test("replay costs nothing while the chunks are cached and re-synthesizes only what was evicted", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  const revokeObjectURL = mock(() => {});
  URL.revokeObjectURL = revokeObjectURL;
  useFakeAudio();

  const view = await mount(LONG);
  await confirm(view);
  const synthesized = posts;
  expect(synthesized).toBeGreaterThan(1);

  /* Stopping leaves the message replayable, and the replay is free. */
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(view.button.getAttribute("aria-label")).toContain("Replay");
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(posts).toBe(synthesized);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  flushSync(() => { view.button.click(); });
  await drainUpdates();

  /* After eviction the replay control still works — it just pays again. */
  evictTtsAudio();
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(posts).toBeGreaterThan(synthesized);
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

test("a message past the ceiling refuses out loud instead of being cut short", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("word ".repeat(MAX_TTS_MESSAGE_LENGTH / 4));
  flushSync(() => { view.button.click(); });
  await drainUpdates();

  expect(view.host.textContent).toContain(`Too long to read aloud (${MAX_TTS_MESSAGE_LENGTH.toLocaleString()} character limit)`);
  expect(view.host.textContent).not.toContain("Speak the first");
  const speak = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  expect(speak.disabled).toBe(true);
  flushSync(() => { speak.click(); });
  await drainUpdates();
  expect(posts).toBe(0);
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("a chunk failure mid-sequence surfaces the provider error and stops cleanly", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    if (posts === 1) return new Response(new Blob(["audio"]));
    return Response.json({ error: "openai TTS failed (HTTP 401)" }, { status: 502 });
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount(LONG);
  await confirm(view);

  const alert = view.host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe("openai TTS failed (HTTP 401)");
  expect(view.button.getAttribute("aria-label")).not.toContain("Stop");
  expect(FakeAudio.instances.every((element) => element.paused)).toBe(true);
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("audio the browser refuses to play reports that, not a provider failure", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  FakeAudio.instances = [];
  globalThis.Audio = class extends FakeAudio {
    override async play() {
      await super.play();
      /* Unlocked on the silent clip, blocked on the real one. */
      if (this.src.startsWith("blob:")) throw new DOMException("blocked", "NotAllowedError");
    }
  } as unknown as typeof Audio;

  const view = await mount("A short answer to read.");
  await confirm(view);

  expect(view.host.querySelector('[role="alert"]')!.textContent).toBe("The browser blocked audio playback. Try again.");
  expect(view.button.getAttribute("aria-label")).not.toContain("Stop");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("the spoken word is highlighted in the rendered answer and a click in it seeks", async () => {
  const sent: string[] = [];
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    sent.push(text);
    if (sent.length === 1) return new Response(new Blob(["audio"]));
    return new Promise<Response>((resolve) => pending.set(text, resolve));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mountInFeed(LONG);
  await confirm(view);
  const element = playing()!;
  expect(element).toBeDefined();

  /* Halfway through the first chunk's audio, halfway through its words. */
  element.tick(5);
  await drainUpdates();
  const paint = highlights.get("tts-karaoke")!;
  expect(paint.ranges).toHaveLength(1);
  const spoken = paint.ranges[0]!.toString();
  expect(spoken.trim()).not.toBe("");
  expect(LONG.slice(0, sent[0]!.length)).toContain(spoken);

  /* A click deep in the answer seeks there — that chunk is queued for it. */
  const node = view.body.firstChild!;
  const target = LONG.lastIndexOf("Sentence number 39");
  Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: node, offset: target }) });
  flushSync(() => {
    view.body.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
  });
  await drainUpdates();
  const seeked = sent.at(-1)!;
  expect(seeked).toContain("Sentence number 39");
  expect(element.paused).toBe(true);

  /* Stopping takes the highlight and the seek affordance away again. */
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(highlights.has("tts-karaoke")).toBe(false);
  expect(view.body.hasAttribute("data-tts-seekable")).toBe(false);
  Object.assign(document, { caretPositionFromPoint: undefined });
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("the confirmation dialog supports Escape, focus restoration, and Enter", async () => {
  let postRequests = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    postRequests += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:keyboard";
  useFakeAudio();

  const view = await mount("Keyboard answer");
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  let dialog = view.host.querySelector('[role="dialog"]') as HTMLElement;
  expect(dialog.contains(document.activeElement)).toBe(true);
  flushSync(() => { dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
  await drainUpdates();
  expect(view.host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(view.button);

  flushSync(() => { view.button.click(); });
  await drainUpdates();
  dialog = view.host.querySelector('[role="dialog"]') as HTMLElement;
  flushSync(() => { dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event); });
  await drainUpdates();
  expect(postRequests).toBe(1);
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

test("provider changes synchronize every answer control before confirmation", async () => {
  const elevenInfo = {
    ...backendInfo,
    backend: "elevenlabs",
    options: backendInfo.options.map((option) => option.id === "elevenlabs" ? { ...option, available: true } : option),
  };
  let current = backendInfo;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tts/backend" && init?.method === "POST") {
      current = elevenInfo;
      return Response.json(current);
    }
    if (url === "/api/tts/backend") return Response.json(current);
    throw new Error("unexpected synthesis");
  }) as unknown as typeof fetch;

  const first = await mount("Provider first");
  const second = await mount("Provider second");
  flushSync(() => { first.button.click(); });
  await drainUpdates();
  const eleven = [...first.host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("elevenlabs"))!;
  flushSync(() => { eleven.click(); });
  await drainUpdates();

  flushSync(() => { second.button.click(); });
  await drainUpdates();
  expect(second.host.textContent).toContain("elevenlabs · eleven_multilingual_v2 · Rachel");
  flushSync(() => { first.root.unmount(); second.root.unmount(); });
  first.host.remove();
  second.host.remove();
});
