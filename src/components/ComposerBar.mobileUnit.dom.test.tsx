import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useComposer } from "@/hooks/useComposer";
import { setLocale } from "@/lib/i18n";

import { ComposerBar, composerSlotKind, type ComposerSendSlot } from "./ComposerBar";

/*
 * Mobile v2 lane 5 (#1439) — the phone's composer UNIT, README §2 rule 8 and
 * §3.4. This file used to hold the #419/#499 contract it replaces: an input
 * row, a 44 px model/reasoning pill row UNDER it, and the attachment picker
 * folded behind a disclosure toggle on the input row. The operator photographed
 * that stack — pill row, status row, live-tail pill — above the keyboard and
 * asked for one unit, so the assertions move with the design:
 *
 *  - one box, the field on top and ONE tools row inside it: chip, attach,
 *    dictate, send slot;
 *  - no row under the box and no disclosure to find;
 *  - every control a real 44 px box, not a 32 px one with a pseudo-element (the
 *    capture's hit gate reads bounding boxes);
 *  - the send slot is Stop / send / Queue / Respawn, and the non-send kinds act
 *    instead of submitting.
 *
 * Desktop keeps the input row plus one inline options row, unchanged.
 */

const dom = new Window();
let mobile = false;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

afterEach(() => {
  document.body.replaceChildren();
  setLocale("en");
  mobile = false;
});

function Harness({ onAttachFiles, sendDisabledReason, onSendBlockedRecover, sendSlot, showImage = true, leftSlot = <span data-testid="left-marker">runtime</span> }: {
  onAttachFiles?: (files: File[]) => void;
  sendDisabledReason?: string;
  onSendBlockedRecover?: () => void;
  sendSlot?: ComposerSendSlot | null;
  showImage?: boolean;
  leftSlot?: React.ReactNode;
}) {
  const composer = useComposer({ initialText: () => "", persistText: () => {}, submit: () => {} });
  return (
    <ComposerBar
      composer={composer}
      placeholder="Prompt"
      textareaAriaLabel="Prompt"
      imageAriaLabel="Add images"
      leftSlot={leftSlot}
      sendSlot={sendSlot}
      showImage={showImage}
      sendLabelIdle="Send"
      sendLabelRecording="Stop"
      sendIdleClassName="bg-accent"
      onAttachFiles={onAttachFiles}
      sendDisabledReason={sendDisabledReason}
      onSendBlockedRecover={onSendBlockedRecover}
    />
  );
}

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

test("desktop keeps the model/attachment second row inline with no disclosure toggle", () => {
  mobile = false;
  const { host, root } = mount(<Harness />);
  expect(host.querySelector('[data-testid="composer-options-row"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="left-marker"]')).toBeTruthy();
  expect(host.querySelector('button[aria-label="Add images"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="composer-options-toggle"]')).toBeNull();
  /* And no phone hooks leak onto the desktop composer. */
  expect(host.querySelector("[data-mobile2-composer]")).toBeNull();
  expect(host.querySelector("[data-mobile2-field]")).toBeNull();
  flushSync(() => root.unmount());
});

test("the phone composer is ONE box: the field, then one tools row inside it", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  const box = host.querySelector("[data-mobile2-composer]")!;
  expect(box).toBeTruthy();
  const field = host.querySelector("[data-mobile2-field]")!;
  const tools = host.querySelector("[data-mobile2-tools]")!;
  /* Both inside the same box, the field first. */
  expect(box.contains(field)).toBe(true);
  expect(box.contains(tools)).toBe(true);
  expect(field.compareDocumentPosition(tools) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
  /* The chip is a cell of that row — not a row of its own under the box. */
  expect(tools.querySelector('[data-testid="left-marker"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="composer-runtime-row"]')).toBeNull();
  /* The attachment picker is on the row too: nothing to disclose, no toggle. */
  expect(tools.querySelector('button[aria-label="Add images"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="composer-options-toggle"]')).toBeNull();
  expect(host.querySelector('[data-testid="composer-options-row"]')).toBeNull();
  flushSync(() => root.unmount());
});

test("the tools row reserves 44 px and every control in it is a real 44 px box", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  const tools = host.querySelector("[data-mobile2-tools]")!;
  expect(tools.className).toContain("min-h-11");
  const picker = host.querySelector('button[aria-label="Add images"]') as HTMLButtonElement;
  const send = host.querySelector("[data-mobile2-send]") as HTMLButtonElement;
  for (const control of [picker, send]) {
    expect(control.className).toContain("h-11");
    /* The retired recipe was a 32 px control with a pseudo-element hit area,
       which measures 32 px to anything reading a bounding box. */
    expect(control.className).not.toContain("before:-inset-1.5");
  }
  /* MicButton's own idle face is that 32 px control and lives outside this
     lane, so the unit sizes it from its wrapper instead. */
  const micWrap = [...tools.children].find((child) => child.className.includes("[&>span>button]:h-11"));
  expect(micWrap).toBeTruthy();
  flushSync(() => root.unmount());
});

test("the phone field is 16 px so iOS never zooms the page to reach it", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  expect(host.querySelector("[data-mobile2-field]")!.className).toContain("text-[16px]");
  flushSync(() => root.unmount());
});

test("the send slot is the ordinary submit with no slot handed in", () => {
  mobile = true;
  const { host, root } = mount(<Harness />);
  const send = host.querySelector("[data-mobile2-send]") as HTMLButtonElement;
  expect(send.getAttribute("data-mobile2-send")).toBe("send");
  expect(send.getAttribute("type")).toBe("submit");
  flushSync(() => root.unmount());
});

test("Stop acts instead of submitting, and stays live with an empty field", () => {
  mobile = true;
  let stopped = 0;
  const { host, root } = mount(
    <Harness sendSlot={{ kind: "stop", label: "Stop the agent", onAct: () => { stopped += 1; } }} />,
  );
  const stop = host.querySelector('[data-mobile2-send="stop"]') as HTMLButtonElement;
  expect(stop).toBeTruthy();
  /* Not a submit: an empty composer cannot send, and Stop must still act. */
  expect(stop.getAttribute("type")).toBe("button");
  expect(stop.disabled).toBe(false);
  expect(stop.getAttribute("aria-label")).toBe("Stop the agent");
  flushSync(() => stop.click());
  expect(stopped).toBe(1);
  flushSync(() => root.unmount());
});

test("Queue and Respawn name themselves on the slot; Respawn acts, Queue submits", () => {
  mobile = true;
  let respawned = 0;
  const queue = mount(<Harness sendSlot={{ kind: "queue", label: "Queue — delivers when reconnected", text: "Queue" }} />);
  const queueBtn = queue.host.querySelector('[data-mobile2-send="queue"]') as HTMLButtonElement;
  expect(queueBtn.textContent).toContain("Queue");
  expect(queueBtn.getAttribute("type")).toBe("submit");
  flushSync(() => queue.root.unmount());

  const respawn = mount(
    <Harness sendSlot={{ kind: "respawn", label: "Respawn the agent", text: "Respawn", onAct: () => { respawned += 1; } }} />,
  );
  const respawnBtn = respawn.host.querySelector('[data-mobile2-send="respawn"]') as HTMLButtonElement;
  expect(respawnBtn.textContent).toContain("Respawn");
  expect(respawnBtn.getAttribute("type")).toBe("button");
  /* A killed conversation blocks every send; Respawn is the way back, so it
     must not inherit that block. */
  expect(respawnBtn.disabled).toBe(false);
  flushSync(() => respawnBtn.click());
  expect(respawned).toBe(1);
  flushSync(() => respawn.root.unmount());
});

test("a busy slot action cannot be fired twice", () => {
  mobile = true;
  let acted = 0;
  const { host, root } = mount(
    <Harness sendSlot={{ kind: "stop", label: "Stop the agent", busy: true, onAct: () => { acted += 1; } }} />,
  );
  const stop = host.querySelector('[data-mobile2-send="stop"]') as HTMLButtonElement;
  expect(stop.disabled).toBe(true);
  expect(acted).toBe(0);
  flushSync(() => root.unmount());
});

test("the slot's kind: killed before offline, then a working turn with nothing typed", () => {
  const base = { killed: false, offline: false, working: false, hasDraft: false };
  expect(composerSlotKind(base)).toBe("send");
  /* Working with an empty draft is the Stop case; the first keystroke flips it
     back to send and the message queues behind the turn (§4.2). */
  expect(composerSlotKind({ ...base, working: true })).toBe("stop");
  expect(composerSlotKind({ ...base, working: true, hasDraft: true })).toBe("send");
  expect(composerSlotKind({ ...base, offline: true })).toBe("queue");
  expect(composerSlotKind({ ...base, offline: true, working: true })).toBe("queue");
  /* Killed outranks offline: a queue that cannot drain is not the useful
     action, getting an agent back is. */
  expect(composerSlotKind({ ...base, killed: true, offline: true, working: true })).toBe("respawn");
});

test("a blocked Send explains itself inline and offers the recovery action", () => {
  mobile = true;
  let recovered = 0;
  const { host, root } = mount(
    <Harness sendDisabledReason="Resolving conversation host…" onSendBlockedRecover={() => { recovered += 1; }} />,
  );
  /* The reason is visible text in a live region — never tooltip-only, which a
     phone cannot hover (issue #499). */
  const reason = host.querySelector('[data-testid="composer-send-blocked"]')!;
  expect(reason).toBeTruthy();
  expect(reason.getAttribute("role")).toBe("status");
  expect(reason.textContent).toContain("Resolving conversation host…");
  /* And it carries a recovery route, not just an explanation. */
  const recover = reason.querySelector("button") as HTMLButtonElement;
  expect(recover).toBeTruthy();
  expect(recover.textContent).toContain("Re-check");
  flushSync(() => recover.click());
  expect(recovered).toBe(1);
  flushSync(() => root.unmount());
});

test("the phone textarea still owns paste, with the picker on the row beside it", () => {
  mobile = true;
  const delivered: File[][] = [];
  const { host, root } = mount(<Harness onAttachFiles={(files) => delivered.push(files)} />);
  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  const imageFile = { name: "shot.png", type: "image/png" } as File;
  props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => imageFile }] },
    preventDefault() {},
  });
  expect(delivered).toEqual([[imageFile]]);
  flushSync(() => root.unmount());
});

test("with images off, the tools row is the chip, the mic and the slot", () => {
  mobile = true;
  const { host, root } = mount(<Harness showImage={false} />);
  const tools = host.querySelector("[data-mobile2-tools]")!;
  expect(tools.querySelector('[data-testid="left-marker"]')).toBeTruthy();
  expect(host.querySelector('button[aria-label="Add images"]')).toBeNull();
  expect(host.querySelector("[data-mobile2-send]")).toBeTruthy();
  flushSync(() => root.unmount());
});
