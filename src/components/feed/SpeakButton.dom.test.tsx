import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";
import { chunkSpeech, MAX_CHUNK_CHARS } from "@/lib/ttsChunks";

import { SpeakButton } from "./SpeakButton";
import { chunksCached, clearTtsCache, evictTtsAudio, voiceKey } from "./ttsSession";

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

/** Ends every chunk in turn, the way the browser would, until nothing plays. */
async function playToEnd(): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const element = playing();
    if (!element) return;
    element.finish();
    await drainUpdates();
  }
  throw new Error("playback never finished");
}

/** The left click: the whole play path since #1024. */
async function speak(view: { button: HTMLButtonElement }): Promise<void> {
  flushSync(() => { view.button.click(); });
  await drainUpdates();
}

/** The right click, and the menu it opens. */
async function openMenu(view: { button: HTMLButtonElement }): Promise<HTMLElement> {
  flushSync(() => {
    view.button.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
  return document.querySelector("[data-tts-menu]") as HTMLElement;
}

function menuOpen(): boolean {
  return document.querySelector("[data-tts-menu]") !== null;
}

/* The refusal/error popover. Portalled to the body like the menu (#1024): an
   inline `absolute` alert is clipped by the message row's paint containment
   and painted over by the next message, and since the left click speaks it is
   the only feedback a refused click gives. */
function alertNode(): HTMLElement | null {
  return document.querySelector("[data-tts-alert]") as HTMLElement | null;
}

/* The TTS configuration is one module-level singleton shared by every control
   on the page (one fetch, all controls in step), and only a right-click menu
   re-reads it. So the two tests that change the active provider come LAST in
   this file: a test that left `elevenlabs` behind would refuse to speak in
   every test declared after it. */
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

/* The operator's complaint in #1024: the left click opened a confirm popover
   instead of speaking. Nothing may stand between the click and the audio. */
test("a left click starts synthesis at once, with no dialog in between", async () => {
  const sent: string[] = [];
  let configRequests = 0;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) { configRequests += 1; return Response.json(backendInfo); }
    sent.push(String(input));
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount("Read me at once");
  const other = await mount("Another answer");
  /* One configuration load for every control on the page, and it is the mount
     that pays for it — the click path never waits on the network twice. */
  expect(configRequests).toBe(1);
  await speak(view);

  expect(sent).toEqual(["/api/tts"]);
  expect(playing()).toBeDefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(menuOpen()).toBe(false);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");

  /* Clicking again stops, and nothing else was bought on the way. */
  await speak(view);
  expect(playing()).toBeUndefined();
  expect(sent).toEqual(["/api/tts"]);
  expect(view.button.getAttribute("aria-label")).not.toContain("Stop");
  flushSync(() => { view.root.unmount(); });
  flushSync(() => { other.root.unmount(); });
  view.host.remove();
  other.host.remove();
});

test("a second click cancels pending synthesis and ignores its stale response", async () => {
  let resolvePost!: (response: Response) => void;
  let postSignal: AbortSignal | undefined;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    postSignal = init.signal as AbortSignal;
    return new Promise<Response>((resolve) => { resolvePost = resolve; });
  }) as unknown as typeof fetch;
  const createObjectURL = mock(() => "blob:tts");
  URL.createObjectURL = createObjectURL;
  useFakeAudio();

  const view = await mount("Read me");
  const other = await mount("Another answer");
  await speak(view);
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
  await speak(view);

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
  expect(alertNode()).toBeNull();
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

test("a message read to the end replays free, and an evicted one says it costs again", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  URL.revokeObjectURL = mock(() => {});
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);
  await playToEnd();
  const synthesized = posts;
  expect(synthesized).toBeGreaterThan(1);

  /* Read to the end with every chunk cached: the replay is genuinely free, and
     both the tooltip and the menu say exactly that. */
  expect(view.button.getAttribute("title")).toBe("Replay aloud (free) · right-click: voice & billing");
  const menu = await openMenu(view);
  expect(menu.textContent).toContain("Next click: free replay from the cache");
  expect(menu.textContent).not.toContain("Next click: paid");
  flushSync(() => { view.button.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
  await drainUpdates();

  await speak(view);
  expect(posts).toBe(synthesized);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  expect(alertNode()).toBeNull();
  await speak(view);

  /* Evicted between the render that promised a free replay and the click that
     took it: the audio still starts, and the control says out loud that this
     one is paid instead of letting the stale label pass for free. */
  evictTtsAudio();
  await speak(view);
  expect(posts).toBeGreaterThan(synthesized);
  expect(alertNode()!.textContent).toBe("Cached audio expired — this replay is a paid synthesis.");
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

/* The operator paid for ONE read-aloud. Stopping it after the first of two
   dozen chunks must not turn the control into a free-replay button that
   silently buys the other twenty-three. */
test("a message stopped after the first chunk never advertises a free replay", async () => {
  let posts = 0;
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    return new Promise<Response>((resolve) => pending.set(text, resolve));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);
  const [first] = [...pending.keys()];
  pending.get(first!)!(new Response(new Blob(["audio"])));
  await drainUpdates();
  expect(playing()).toBeDefined();

  await speak(view);
  const paidForFirstChunk = posts;

  expect(view.button.getAttribute("title")).toBe("Read aloud (paid) · right-click: voice & billing");
  expect(view.button.getAttribute("aria-label")).toBe("Read answer aloud");
  const menu = await openMenu(view);
  expect(menu.textContent).toContain("Next click: paid synthesis of this answer");
  expect(menu.textContent).toContain("Billed to your openai account per character");
  expect(menu.textContent).toContain("AI-generated voice");
  expect(menu.textContent).not.toContain("free replay");

  /* And the next click does pay — immediately, without asking. */
  await speak(view);
  expect(posts).toBeGreaterThan(paidForFirstChunk);
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

/* The menu is where the paid/cached truth lives since #1024, so it may not
   state what the next click costs from a snapshot taken before playback began
   or before another card evicted these chunks. */
test("the menu's cost line follows playback and cache eviction while it is open", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  URL.revokeObjectURL = mock(() => {});
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);
  await playToEnd();

  const cached = await openMenu(view);
  expect(cached.textContent).toContain("Next click: free replay from the cache");

  /* Evicted from under an OPEN menu — nothing re-renders the control, so the
     menu has to hear it from the cache itself. */
  flushSync(() => { evictTtsAudio(); });
  await drainUpdates();
  expect(cached.textContent).toContain("Next click: paid synthesis of this answer");
  expect(cached.textContent).not.toContain("free replay");

  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();

  /* Right-click while it is reading: the next left click stops, and costs
     nothing either way. */
  await speak(view);
  expect(playing()).toBeDefined();
  const reading = await openMenu(view);
  expect(reading.textContent).toContain("Next click: stop reading this answer");
  expect(reading.textContent).not.toContain("paid synthesis");
  expect(reading.textContent).not.toContain("free replay");

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
  await speak(view);

  const alert = alertNode()!;
  expect(alert.textContent).toContain(`Too long to read aloud (${MAX_TTS_MESSAGE_LENGTH.toLocaleString()} character limit)`);
  expect(posts).toBe(0);
  expect(playing()).toBeUndefined();
  /* And it is a popover on the body, not a box inside the message: the feed row
     carries `content-visibility: auto`, whose paint containment clips an inline
     `absolute` alert and lets the next message paint over what survives. A key
     path still breaks anywhere, the way the removed dialog wrapped it. */
  expect(alert.parentElement).toBe(document.body as unknown as HTMLElement);
  expect(view.host.contains(alert)).toBe(false);
  expect(alert.className).toContain("fixed");
  expect(alert.className).toContain("break-all");
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
  await speak(view);

  const alert = alertNode()!;
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
  await speak(view);

  expect(alertNode()!.textContent).toBe("The browser blocked audio playback. Try again.");
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
  await speak(view);
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

test("the right-click menu opens outside the message, and Escape closes it back onto the trigger", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("Menu answer");
  const menu = await openMenu(view);

  /* Portalled to the body, so no feed overflow and no later message can clip
     it — the message's own subtree does not contain it. */
  expect(menu).not.toBeNull();
  expect(menu.parentElement).toBe(document.body as unknown as HTMLElement);
  expect(view.host.contains(menu)).toBe(false);
  expect(menu.className).toContain("fixed");
  expect(view.button.getAttribute("aria-expanded")).toBe("true");
  expect(menu.contains(document.activeElement as Node)).toBe(true);
  expect(menu.textContent).toContain("Voice & billing");
  expect(menu.textContent).toContain("11 characters");
  expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  /* Opening the menu buys nothing. */
  expect(posts).toBe(0);

  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement).toBe(view.button);
  expect(view.button.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("an outside pointerdown closes the menu, and a second right-click toggles it shut", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    throw new Error("unexpected synthesis");
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("Dismissal answer");
  await openMenu(view);
  flushSync(() => {
    document.body.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(menuOpen()).toBe(false);

  await openMenu(view);
  expect(menuOpen()).toBe(true);
  /* The right-click's own pointerdown lands on the trigger and must not close
     the menu out from under the contextmenu that follows it. */
  flushSync(() => {
    view.button.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(menuOpen()).toBe(true);
  await openMenu(view);
  expect(menuOpen()).toBe(false);
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("the menu switches provider, and every answer control follows", async () => {
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
  const menu = await openMenu(first);
  const eleven = [...menu.querySelectorAll("button")].find((button) => button.textContent?.startsWith("elevenlabs"))!;
  flushSync(() => { eleven.click(); });
  await drainUpdates();
  expect(menuOpen()).toBe(false);

  const other = await openMenu(second);
  expect(other.textContent).toContain("elevenlabs · eleven_multilingual_v2 · Rachel");
  expect(first.button.getAttribute("title")).toBe("Read aloud (paid) · right-click: voice & billing");
  flushSync(() => { first.root.unmount(); second.root.unmount(); });
  first.host.remove();
  second.host.remove();
});

test("a provider with no key refuses out loud and names the file to drop it into", async () => {
  const noKey = { ...backendInfo, backend: "elevenlabs" };
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(noKey);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("Nothing can read this");
  /* Opening the menu is what re-reads the configuration, so the control learns
     the provider changed under it without a round trip on the play path. */
  const menu = await openMenu(view);
  expect(menu.textContent).toContain("Add the elevenlabs API key at /keys/elevenlabs");
  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
  await speak(view);

  expect(posts).toBe(0);
  expect(alertNode()!.textContent).toBe("Add the elevenlabs API key at /keys/elevenlabs");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

/* Declared LAST: it leaves `elevenlabs` behind in the module-level singleton.

   The tab's copy of the configuration is fetched once per page load, so an
   operator who switches provider in a second tab leaves this one asking for a
   provider the server no longer uses. The route says who it actually billed,
   and the answer — not the belief — decides the cache key and the name on the
   surface (#1024). */
test("a provider switched under a stale tab is keyed and named by what the route billed", async () => {
  const TEXT = "Billed somewhere else entirely.";
  const elevenActive = {
    ...backendInfo,
    backend: "elevenlabs",
    options: backendInfo.options.map((option) => (option.id === "elevenlabs" ? { ...option, available: true } : option)),
  };
  let served = backendInfo;
  let posts = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    if (String(input) === "/api/tts/backend") return Response.json(served);
    posts += 1;
    /* The server is on ElevenLabs now, whatever this tab believes. */
    return new Response(new Blob(["audio"]), {
      headers: { "x-tts-backend": "elevenlabs", "x-tts-model": "eleven_multilingual_v2", "x-tts-voice": "Rachel" },
    });
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount(TEXT);
  /* This tab last read the configuration while openai was active. */
  const before = await openMenu(view);
  expect(before.textContent).toContain("openai · gpt-4o-mini-tts · alloy");
  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();

  served = elevenActive;
  await speak(view);
  await playToEnd();
  expect(posts).toBeGreaterThan(0);

  /* Nothing was filed under the voice this tab named on its way out... */
  const texts = chunkSpeech(TEXT).map((chunk) => chunk.text);
  expect(chunksCached(texts.map((text) => voiceKey({ id: "openai", model: "gpt-4o-mini-tts", voice: "alloy" }, text)))).toBe(false);
  /* ...and everything under the one that answered. */
  expect(chunksCached(texts.map((text) => voiceKey({ id: "elevenlabs", model: "eleven_multilingual_v2", voice: "Rachel" }, text)))).toBe(true);

  /* And the surface names the provider that was charged, without the click
     having waited on /api/tts/backend to find out. */
  expect(alertNode()!.textContent).toBe("The voice provider changed — this read is billed to elevenlabs.");
  const after = await openMenu(view);
  expect(after.textContent).toContain("elevenlabs · eleven_multilingual_v2 · Rachel");
  expect(after.textContent).toContain("Billed to your elevenlabs account per character");
  /* The replay it now offers is a replay of the audio that was actually paid
     for, so it is genuinely free. */
  expect(after.textContent).toContain("Next click: free replay from the cache");

  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});
