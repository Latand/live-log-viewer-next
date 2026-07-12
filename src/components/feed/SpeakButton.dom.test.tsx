import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";

import { SpeakButton } from "./SpeakButton";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const backendInfo = {
  backend: "openai",
  lockedByEnv: false,
  options: [
    { id: "openai", available: true, keyPath: "/keys/openai", model: "gpt-4o-mini-tts", voice: "alloy", cap: MAX_TTS_TEXT_LENGTH },
    { id: "elevenlabs", available: false, keyPath: "/keys/elevenlabs", model: "eleven_multilingual_v2", voice: "Rachel", cap: MAX_TTS_TEXT_LENGTH },
  ],
};

async function drainUpdates(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
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
  globalThis.Audio = class {
    muted = false;
    src = "";
    currentTime = 0;
    duration = 0;
    onloadedmetadata: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src = "") { this.src = src; }
    pause() {}
    async play() {}
  } as unknown as typeof Audio;

  const view = await mount("Read me");
  const other = await mount("Another answer");
  expect(configRequests).toBe(1);
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(view.host.textContent).toContain("Billed to your openai account per character");
  expect(view.host.textContent).toContain("AI-generated voice");
  expect(postSignal).toBeUndefined();
  const confirm = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  flushSync(() => { confirm.click(); });
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

test("long answers require consent and cached replay makes no paid request", async () => {
  let sentText = "";
  let postRequests = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    postRequests += 1;
    sentText = (JSON.parse(String(init.body)) as { text: string }).text;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  const revokeObjectURL = mock(() => {});
  URL.revokeObjectURL = revokeObjectURL;
  globalThis.Audio = class {
    muted = false;
    src = "";
    currentTime = 0;
    duration = 10;
    private authorized = false;
    onloadedmetadata: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src = "") { this.src = src; }
    pause() {}
    async play() {
      if (this.muted && this.src.startsWith("data:audio/wav")) this.authorized = true;
      if (!this.authorized && !this.src.startsWith("blob:")) throw new DOMException("blocked", "NotAllowedError");
    }
  } as unknown as typeof Audio;

  const view = await mount("x".repeat(MAX_TTS_TEXT_LENGTH + 100));
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(view.host.textContent).toContain(`Speak the first ${MAX_TTS_TEXT_LENGTH.toLocaleString()} characters?`);
  const confirm = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  flushSync(() => { confirm.click(); });
  await drainUpdates();
  expect(sentText).toHaveLength(MAX_TTS_TEXT_LENGTH);
  expect(postRequests).toBe(1);
  expect(view.host.querySelector('[role="alert"]')).toBeNull();
  flushSync(() => { view.button.click(); });
  expect(view.button.getAttribute("aria-label")).toContain("Replay");
  flushSync(() => { view.button.click(); });
  expect(postRequests).toBe(1);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  flushSync(() => { view.button.click(); view.root.unmount(); });
  expect(revokeObjectURL).not.toHaveBeenCalled();
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
  globalThis.Audio = class {
    muted = false;
    src = "";
    currentTime = 0;
    duration = 1;
    onloadedmetadata: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src = "") { this.src = src; }
    pause() {}
    async play() {}
  } as unknown as typeof Audio;

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
