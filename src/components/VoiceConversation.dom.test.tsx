import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { translate, type TFunction } from "@/lib/i18n";

import { VoiceConversationButton, VoiceConversationPanel } from "./VoiceConversation";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
});

afterEach(() => {
  document.body.replaceChildren();
});

const t: TFunction = (key, params) => translate("en", key, params);

test("renders one persistent voice transcript panel beside the call control", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <>
      <VoiceConversationButton phase="live" start={async () => {}} stop={async () => {}} t={t} />
      <VoiceConversationPanel
        phase="live"
        error={null}
        lines={[
          { id: "u", role: "user", text: "Inspect the board", final: true },
          { id: "p", role: "progress", text: "Reading current agents", final: false },
          { id: "a", role: "assistant", text: "Three agents are active", final: true },
        ]}
        t={t}
      />
    </>,
  ));

  expect(host.querySelector('button[aria-label="End voice conversation"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('section[aria-label="Voice conversation"]')?.textContent).toContain("Inspect the board");
  expect(host.textContent).toContain("Reading current agents");
  expect(host.textContent).toContain("Three agents are active");
  flushSync(() => root.unmount());
});

test("keeps backend admission failures visible and leaves restart available", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <>
      <VoiceConversationButton phase="error" start={async () => {}} stop={async () => {}} t={t} />
      <VoiceConversationPanel phase="error" error="AVAS route unavailable" lines={[]} t={t} />
    </>,
  ));
  expect(host.querySelector('button[aria-label="Start continuous voice conversation"]')).toBeTruthy();
  expect(host.textContent).toContain("AVAS route unavailable");
  flushSync(() => root.unmount());
});

test("a live call shows its running duration and a microphone level readout", () => {
  /* A call is the one thing on this surface with no other visible duration: a
     stalled connection and a working one look identical without it. */
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <VoiceConversationPanel
      phase="live"
      error={null}
      startedAt={Date.now() - 62_000}
      stream={null}
      lines={[{ id: "u", role: "user", text: "Still there?", final: true }]}
      t={t}
    />,
  ));
  expect(host.querySelector('[data-testid="voice-elapsed"]')?.textContent).toBe("1:02");
  expect(host.querySelector('[data-testid="voice-mic-level"]')?.getAttribute("aria-label")).toBe("Microphone level");
  expect(host.querySelector("section")?.getAttribute("data-phase")).toBe("live");
  flushSync(() => root.unmount());
});

test("neither the timer nor the meter renders outside a live call", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <VoiceConversationPanel
      phase="connecting"
      error={null}
      startedAt={null}
      lines={[]}
      t={t}
    />,
  ));
  expect(host.querySelector('[data-testid="voice-elapsed"]')).toBeNull();
  expect(host.querySelector('[data-testid="voice-mic-level"]')).toBeNull();
  expect(host.textContent).toContain("Connecting voice…");
  flushSync(() => root.unmount());
});

test("a failed call raises the backend reason as an alert with a retry action", () => {
  /* The reason is the backend's own words (#664); the operator's next move is
     almost always to try again, so the action belongs beside the message. */
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const retries: number[] = [];
  flushSync(() => root.render(
    <VoiceConversationPanel
      phase="error"
      error="You have reached your usage limit."
      startedAt={null}
      lines={[{ id: "a", role: "assistant", text: "On the line.", final: true }]}
      onRetry={() => retries.push(1)}
      t={t}
    />,
  ));
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("You have reached your usage limit.");
  const retry = host.querySelector('[data-testid="voice-retry"]') as HTMLElement;
  expect(retry.textContent).toContain("Try again");
  flushSync(() => retry.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(retries).toHaveLength(1);
  // The transcript survives the failure, so the operator keeps what was said.
  expect(host.textContent).toContain("On the line.");
  flushSync(() => root.unmount());
});

test("an unfinished line keeps a caret so a stalled turn is visibly mid-flight", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <VoiceConversationPanel
      phase="live"
      error={null}
      startedAt={Date.now()}
      lines={[
        { id: "a", role: "assistant", text: "Reading the board", final: false },
        { id: "b", role: "user", text: "Go on", final: true },
      ]}
      t={t}
    />,
  ));
  const carets = host.querySelectorAll("span.animate-pulse[aria-hidden]");
  // One for the live status dot, one for the unfinished line — never for the final one.
  expect(carets.length).toBe(2);
  flushSync(() => root.unmount());
});

test("consecutive turns from one speaker carry a single label", () => {
  /* A per-line label column would have to fit the longest speaker word in
     every translation and would eat the text's width on a phone. */
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <VoiceConversationPanel
      phase="live"
      error={null}
      startedAt={Date.now()}
      lines={[
        { id: "a1", role: "assistant", text: "Reading the board.", final: true },
        { id: "a2", role: "assistant", text: "Three agents are active.", final: true },
        { id: "u1", role: "user", text: "Show me the first.", final: true },
      ]}
      t={t}
    />,
  ));
  const labels = [...host.querySelectorAll("span.uppercase")].map((node) => node.textContent);
  expect(labels).toEqual(["Agent", "You"]);
  expect(host.textContent).toContain("Three agents are active.");
  flushSync(() => root.unmount());
});
