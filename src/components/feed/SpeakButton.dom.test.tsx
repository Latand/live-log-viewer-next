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
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    postSignal = init.signal as AbortSignal;
    return new Promise<Response>((resolve) => { resolvePost = resolve; });
  }) as unknown as typeof fetch;
  const createObjectURL = mock(() => "blob:tts");
  URL.createObjectURL = createObjectURL;

  const view = await mount("Read me");
  flushSync(() => { view.button.click(); });
  expect(view.host.textContent).toContain("Billed to your openai account per character");
  expect(view.host.textContent).toContain("AI-generated voice");
  expect(postSignal).toBeUndefined();
  const confirm = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  flushSync(() => { confirm.click(); });
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  flushSync(() => { view.button.click(); });
  expect(postSignal?.aborted).toBe(true);
  expect(view.button.getAttribute("aria-label")).toContain("Read answer");

  resolvePost(new Response(new Blob(["late"])));
  await drainUpdates();
  expect(createObjectURL).not.toHaveBeenCalled();
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("long answers are bounded before synthesis", async () => {
  let sentText = "";
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    sentText = (JSON.parse(String(init.body)) as { text: string }).text;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  const revokeObjectURL = mock(() => {});
  URL.revokeObjectURL = revokeObjectURL;
  globalThis.Audio = class {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause() {}
    async play() {}
  } as unknown as typeof Audio;

  const view = await mount("x".repeat(MAX_TTS_TEXT_LENGTH + 100));
  flushSync(() => { view.button.click(); });
  expect(view.host.textContent).toContain(`Speak the first ${MAX_TTS_TEXT_LENGTH.toLocaleString()} characters?`);
  const confirm = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Speak")!;
  flushSync(() => { confirm.click(); });
  await drainUpdates();
  expect(sentText).toHaveLength(MAX_TTS_TEXT_LENGTH);
  flushSync(() => { view.button.click(); view.root.unmount(); });
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:tts");
  view.host.remove();
});
