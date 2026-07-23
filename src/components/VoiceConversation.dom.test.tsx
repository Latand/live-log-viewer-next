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
