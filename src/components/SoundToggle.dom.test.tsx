import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.Event,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const { SoundToggle } = await import("./SoundToggle");
const {
  configureAudioPrefsStorage,
  readAudioPrefs,
  CUE_VOLUME_KEY,
  LOOP_ENABLED_KEY,
  LOOP_VOLUME_KEY,
} = await import("@/lib/audio/prefs");
const { AMBIENT_LOOP_ASSET } = await import("@/lib/audio/loopAsset");

/** This browser profile's storage — the only place these settings ever live. */
function deviceStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    dump: () => Object.fromEntries(values),
  };
}

let storage: ReturnType<typeof deviceStorage>;
let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  storage = deviceStorage();
  configureAudioPrefsStorage(storage);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  configureAudioPrefsStorage(undefined);
});

async function render(props: { ambientAvailable?: boolean } = {}) {
  host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => root!.render(<SoundToggle {...props} />));
  return host;
}

const find = (testId: string) => host.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLButtonElement | null;
const click = async (node: Element) => act(async () => {
  node.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as never);
});

async function openPanel() {
  await click(find("sound-settings-trigger")!);
}

/**
 * Drag a slider.
 *
 * The value goes in through the native setter (React tracks the property, so
 * assigning it directly would hide the change) and the component's own handler
 * is then invoked from the element's React props. happy-dom's synthetic `input`
 * event does not reach React's change plugin for a range input, so the repo's
 * established props-level dispatch is what drives it — the assertion is still
 * about what the COMPONENT does with a slider move.
 */
async function setRange(node: HTMLInputElement, value: string) {
  const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"))!;
  const props = (node as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(node, value);
    props.onChange({ target: node, currentTarget: node });
  });
}

describe("the master switch governs all product audio", () => {
  test("muting and unmuting is written to this device only", async () => {
    await render();
    const master = host.querySelector("button[aria-pressed]") as HTMLButtonElement;
    expect(master.getAttribute("aria-pressed")).toBe("true");

    await click(master);
    expect(master.getAttribute("aria-pressed")).toBe("false");
    expect(readAudioPrefs(storage).cuesEnabled).toBe(false);

    await click(master);
    expect(readAudioPrefs(storage).cuesEnabled).toBe(true);
  });

  test("clicking through the whole cluster on a device that refuses audio never throws", async () => {
    /* happy-dom has no AudioContext, which is exactly what an autoplay-locked or
       audio-less browser looks like to this code: the cue is dropped, silently. */
    expect((dom as unknown as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    await render({ ambientAvailable: true });

    const master = host.querySelector("button[aria-pressed]") as HTMLButtonElement;
    await click(master);
    await click(master);
    await openPanel();
    await setRange(find("cue-volume") as HTMLInputElement, "0.4");
    await click(find("ambient-enabled")!);

    expect(readAudioPrefs(storage).cuesEnabled).toBe(true);
    expect(readAudioPrefs(storage).cueVolume).toBe(0.4);
  });
});

describe("levels are device-local and independent", () => {
  test("the cue level persists for this browser profile", async () => {
    await render();
    await openPanel();

    await setRange(find("cue-volume") as HTMLInputElement, "0.25");

    expect(storage.dump()[CUE_VOLUME_KEY]).toBe("0.25");
    expect(readAudioPrefs(storage).cueVolume).toBe(0.25);
    /* Nothing was written anywhere else: no route, no shared record. */
    expect(Object.keys(storage.dump())).toEqual([CUE_VOLUME_KEY]);
  });

  test("moving the ambient level leaves the cue level alone, and vice versa", async () => {
    await render({ ambientAvailable: true });
    await openPanel();

    await setRange(find("cue-volume") as HTMLInputElement, "0.8");
    await setRange(find("ambient-volume") as HTMLInputElement, "0.15");

    const settings = readAudioPrefs(storage);
    expect(settings.cueVolume).toBe(0.8);
    expect(settings.loopVolume).toBe(0.15);

    await setRange(find("cue-volume") as HTMLInputElement, "0.3");
    expect(readAudioPrefs(storage).loopVolume).toBe(0.15);
  });

  test("an enabled ambient bed is remembered, so the next call brings it back", async () => {
    await render({ ambientAvailable: true });
    await openPanel();

    await click(find("ambient-enabled")!);

    expect(storage.dump()[LOOP_ENABLED_KEY]).toBe("on");
    /* A reload is a fresh read of the same storage: still on, no re-enabling. */
    expect(readAudioPrefs(storage).loopEnabled).toBe(true);
  });
});

describe("the ambient controls exist only when there is something to play", () => {
  test("with no loop asset configured the ambient rows are absent, not disabled", async () => {
    await render({ ambientAvailable: false });
    await openPanel();

    expect(find("sound-settings")).not.toBeNull();
    expect(find("cue-volume")).not.toBeNull();
    /* Absent — a toggle that cannot do anything is worse than no toggle. */
    expect(find("ambient-enabled")).toBeNull();
    expect(find("ambient-volume")).toBeNull();
    expect(host.textContent).not.toContain("Ambient");
    /* And nothing about the loop was written to storage by rendering. */
    expect(storage.dump()[LOOP_ENABLED_KEY]).toBeUndefined();
    expect(storage.dump()[LOOP_VOLUME_KEY]).toBeUndefined();
  });

  test("this release ships an asset, so the shipped panel does show them", async () => {
    expect(AMBIENT_LOOP_ASSET).toBeTruthy();
    await render();
    await openPanel();

    expect(find("ambient-enabled")).not.toBeNull();
    expect(find("ambient-volume")).not.toBeNull();
    /* Conservative first run: shown, and off until this device says otherwise. */
    expect((find("ambient-enabled") as HTMLInputElement).checked).toBe(false);
  });
});
