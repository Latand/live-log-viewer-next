import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TelegramConnectionState } from "@/hooks/useTelegramConnection";
import type { TelegramStatusPayload } from "@/lib/telegram/contracts";
import { installActEnv } from "@/test-helpers/actEnv";

import { TelegramPanel } from "./TelegramConnect";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLFormElement: dom.HTMLFormElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function stateFor(
  status: Partial<TelegramStatusPayload>,
  submitPassword: (password: string) => Promise<void>,
): TelegramConnectionState {
  return {
    status: {
      phase: "disconnected",
      login: null,
      identity: null,
      credentialRef: null,
      lastHealthCheckAt: null,
      error: null,
      ...status,
    },
    busy: false,
    failure: null,
    refresh: async () => {},
    connect: async () => {},
    submitPassword,
    cancel: async () => {},
    logout: async () => {},
    deleteLocal: async () => {},
  };
}

async function renderPanel(state: TelegramConnectionState): Promise<HTMLElement> {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(<TelegramPanel state={state} onClose={() => {}} />));
  return container;
}

const passwordStatus = (): Partial<TelegramStatusPayload> => ({
  phase: "awaiting_password",
  login: { operationId: "op-1", qr: null, passwordError: false },
});

test("the 2FA field is uncontrolled, submits its DOM value, and clears immediately", async () => {
  const submitted: string[] = [];
  const host = await renderPanel(stateFor(passwordStatus(), async (password) => { submitted.push(password); }));
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  const form = input.closest("form") as HTMLFormElement;

  expect(input.hasAttribute("value")).toBe(false);
  expect(input.required).toBe(true);
  input.value = "synthetic-2fa-value";
  await act(async () => {
    form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });

  expect(submitted).toEqual(["synthetic-2fa-value"]);
  expect(input.value).toBe("");
});

test("leaving and re-entering the password phase never restores the old value", async () => {
  const submit = async () => {};
  let host = await renderPanel(stateFor(passwordStatus(), submit));
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  input.value = "synthetic-2fa-value";

  await renderPanel(stateFor({ phase: "verifying" }, submit));
  host = await renderPanel(stateFor(passwordStatus(), submit));
  const nextInput = host.querySelector('input[type="password"]') as HTMLInputElement;
  expect(nextInput.value).toBe("");
});

test("Retry uses the stored credential for recovery when one exists", async () => {
  const calls = { connect: 0, refresh: [] as boolean[] };
  const state = stateFor({
    phase: "error",
    credentialRef: "credential-ref",
    error: { code: "connector_failed" },
  }, async () => {});
  state.connect = async () => { calls.connect += 1; };
  state.refresh = async (fresh = false) => { calls.refresh.push(fresh); };
  const host = await renderPanel(state);
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry");
  expect(retry).toBeDefined();

  await act(async () => { retry!.click(); });

  expect(calls.refresh).toEqual([true]);
  expect(calls.connect).toBe(0);
});
