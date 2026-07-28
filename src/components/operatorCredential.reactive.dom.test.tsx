import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useSyncExternalStore } from "react";

import { installActEnv } from "@/test-helpers/actEnv";
import { translate, type TFunction } from "@/lib/i18n";

import {
  adoptOperatorCredentialFromLocation,
  getServerHasOperatorCredential,
  hasOperatorCredential,
  resetOperatorCredentialForTests,
  subscribeOperatorCredential,
} from "./operatorCredential";
import { VoiceConversationButton } from "./VoiceConversation";

/**
 * Operator authority is a REACTIVE store, proven end to end.
 *
 * The hosted regression this pins down: `browserAuthorized` flipped true inside
 * an async probe, nothing notified React, and the composer — which had read
 * `hasOperatorCredential()` synchronously during its one render — kept the
 * canonical voice button hidden forever. So this renders the exact production
 * wiring (the same subscribe/read pair `TmuxComposerCore` uses, gating the same
 * `VoiceConversationButton`), lets the REAL module run its REAL probe against a
 * stubbed fetch, and asserts the button appears with no reload, no external
 * re-render, and no prop change — and disappears again when a later probe says
 * the session is gone.
 */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
});

const t: TFunction = (key, params) => translate("en", key, params);

/** The production gate, verbatim: subscribe to the credential store, render the
    canonical button exactly when the tab holds operator authority. */
function VoiceControlGate() {
  const operatorTab = useSyncExternalStore(
    subscribeOperatorCredential,
    hasOperatorCredential,
    getServerHasOperatorCredential,
  );
  return operatorTab
    ? <VoiceConversationButton phase="idle" start={async () => undefined} stop={async () => undefined} t={t} />
    : null;
}

let answers: boolean[] = [];
let probes = 0;
let roots: Root[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetOperatorCredentialForTests();
  dom.document.body.replaceChildren();
  answers = [];
  probes = 0;
  roots = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).includes("/api/operator/session")) throw new Error(`unexpected fetch ${String(input)}`);
    probes += 1;
    const operator = answers.length > 1 ? answers.shift()! : answers[0] ?? false;
    return new Response(JSON.stringify({ operator }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  globalThis.fetch = realFetch;
  resetOperatorCredentialForTests();
});

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

const button = () => dom.document.querySelector("[data-testid=voice-call-button]");

test("the canonical button appears when the browser-session probe resolves — no reload, no external re-render", async () => {
  answers = [true];
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<VoiceControlGate />));

  /* Unauthorized at render: no fragment, no storage, probe not yet resolved. */
  expect(button()).toBeNull();

  /* What the Viewer does once per render body; here it runs ONCE, so anything
     that appears later can only have come through the store's own notification. */
  adoptOperatorCredentialFromLocation();
  await settle();

  expect(probes).toBeGreaterThanOrEqual(1);
  expect(button()).not.toBeNull();
  expect(button()!.getAttribute("aria-label")).toBe(t("voice.start"));
});

test("authorization loss on a focus probe hides the button again", async () => {
  answers = [true];
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<VoiceControlGate />));
  adoptOperatorCredentialFromLocation();
  await settle();
  expect(button()).not.toBeNull();

  /* The session is revoked server-side; the next focus probe learns it. */
  answers = [false];
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await settle();
  expect(button()).toBeNull();
});
