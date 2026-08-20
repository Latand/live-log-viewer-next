import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { useTelegramConnection, type TelegramConnectionState } from "./useTelegramConnection";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let latest: TelegramConnectionState | null = null;

function Harness() {
  const state = useTelegramConnection();
  useEffect(() => { latest = state; }, [state]);
  return null;
}

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
    await Bun.sleep(0);
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  latest = null;
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

const telegram = (phase: "disconnected" | "connected") => ({
  phase,
  login: null,
  identity: phase === "connected" ? { name: "Account A", username: null } : null,
  credentialRef: phase === "connected" ? "credential-ref" : null,
  lastHealthCheckAt: null,
  error: null,
});

const startingTelegram = () => ({
  phase: "starting" as const,
  login: { operationId: "op-1", qr: null, passwordError: false },
  identity: null,
  credentialRef: null,
  lastHealthCheckAt: null,
  error: null,
});

test("initial status transport failure is visible", async () => {
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  await mount();
  expect(latest?.status).toBeNull();
  expect(latest?.failure?.code).toBe("transport");
});

test("fresh health non-success response is visible", async () => {
  const responses = [
    new Response(JSON.stringify({ telegram: telegram("disconnected") }), { status: 200 }),
    new Response(JSON.stringify({ code: "health_failed" }), { status: 503 }),
  ];
  globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;
  await mount();
  await act(async () => { await latest!.refresh(true); });
  expect(latest?.failure?.code).toBe("health_failed");
});

test("a slower status response cannot overwrite a newer one", async () => {
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const requests: Array<Promise<Response> | Response> = [
    new Response(JSON.stringify({ telegram: telegram("disconnected") }), { status: 200 }),
    new Promise((resolve) => { resolveOlder = resolve; }),
    new Promise((resolve) => { resolveNewer = resolve; }),
  ];
  globalThis.fetch = (async () => await requests.shift()!) as unknown as typeof fetch;
  await mount();

  let older!: Promise<void>;
  let newer!: Promise<void>;
  await act(async () => {
    older = latest!.refresh(true);
    newer = latest!.refresh(true);
  });
  resolveNewer(new Response(JSON.stringify({ telegram: telegram("connected") }), { status: 200 }));
  await act(async () => { await newer; });
  resolveOlder(new Response(JSON.stringify({ telegram: telegram("disconnected") }), { status: 200 }));
  await act(async () => { await older; });

  expect(latest?.status?.phase).toBe("connected");
});

test("an in-flight poll cannot overwrite a later mutation response", async () => {
  let resolvePoll!: (response: Response) => void;
  const poll = new Promise<Response>((resolve) => { resolvePoll = resolve; });
  const requests: Array<Promise<Response> | Response> = [
    new Response(JSON.stringify({ telegram: telegram("disconnected") }), { status: 200 }),
    poll,
    new Response(JSON.stringify({ telegram: telegram("connected") }), { status: 200 }),
  ];
  globalThis.fetch = (async () => await requests.shift()!) as unknown as typeof fetch;
  await mount();

  let pendingPoll!: Promise<void>;
  await act(async () => {
    pendingPoll = latest!.refresh(true);
    await latest!.connect();
  });
  expect(latest?.status?.phase).toBe("connected");

  resolvePoll(new Response(JSON.stringify({ telegram: telegram("disconnected") }), { status: 200 }));
  await act(async () => { await pendingPoll; });
  expect(latest?.status?.phase).toBe("connected");
});

test("Connect immediately rearms polling for the live login", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    const payload = method === "POST" ? startingTelegram() : requests.length === 1 ? telegram("disconnected") : startingTelegram();
    return new Response(JSON.stringify({ telegram: payload }), { status: 200 });
  }) as unknown as typeof fetch;
  await mount();

  await act(async () => {
    await latest!.connect();
    await Bun.sleep(0);
  });

  expect(requests.filter((request) => request.method === "GET").length).toBe(2);
  expect(requests.at(-1)).toEqual({ url: "/api/telegram", method: "GET" });
});

test("a persisted connected status immediately triggers fresh health recovery", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ telegram: telegram("connected") }), { status: 200 });
  }) as unknown as typeof fetch;

  await mount();
  await act(async () => { await Bun.sleep(0); });

  expect(urls).toEqual(["/api/telegram", "/api/telegram?fresh=1"]);
});
