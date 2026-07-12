import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const originalKey = process.env.OPENAI_API_KEY;
const originalBackend = process.env.LLV_TTS_BACKEND;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalBackend === undefined) delete process.env.LLV_TTS_BACKEND;
  else process.env.LLV_TTS_BACKEND = originalBackend;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  globalThis.fetch = originalFetch;
});

function request(body: string, signal?: AbortSignal): NextRequest {
  return new NextRequest("http://127.0.0.1/api/tts", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body,
    signal,
  });
}

describe("/api/tts", () => {
  test("reports unavailable and returns a clean 503 without an API key", async () => {
    process.env.LLV_TTS_BACKEND = "openai";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-test";
    delete process.env.OPENAI_API_KEY;
    expect(await (await GET()).json()).toEqual({ available: false });
    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "text-to-speech is unavailable" });
  });

  test("returns a clean 400 for a null JSON body", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLV_TTS_BACKEND = "openai";
    const response = await POST(request("null"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "expected a JSON object" });
  });

  test("streams the OpenAI audio response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLV_TTS_BACKEND = "openai";
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const fetchMock = mock(async (...args: [string | URL | Request, RequestInit?]) => {
      void args;
      return new Response(stream, { headers: { "content-type": "audio/mpeg" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Read this answer." })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Read this answer.",
      response_format: "mp3",
    });
  });

  test("rejects non-audio and oversized upstream responses", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLV_TTS_BACKEND = "openai";
    globalThis.fetch = mock(async () => new Response("not audio", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello" })))).status).toBe(502);

    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/mpeg", "content-length": String(32 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello" })))).status).toBe(502);
  });

  test("propagates client cancellation to the provider request", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLV_TTS_BACKEND = "openai";
    const client = new AbortController();
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      providerSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        if (providerSignal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        providerSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;

    const pending = POST(request(JSON.stringify({ text: "Hello" }), client.signal));
    client.abort();
    expect((await pending).status).toBe(499);
    expect(providerSignal?.aborted).toBe(true);
  });

  test("admits three concurrent syntheses and releases every slot", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLV_TTS_BACKEND = "openai";
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = mock(async () => new Promise<Response>((resolve) => pending.push(resolve))) as unknown as typeof fetch;
    const requests = [1, 2, 3].map((n) => POST(request(JSON.stringify({ text: `Hello ${n}` }))));
    while (pending.length < 3) await Promise.resolve();
    expect((await POST(request(JSON.stringify({ text: "Fourth" })))).status).toBe(429);
    for (const resolve of pending) resolve(new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }));
    for (const response of await Promise.all(requests)) await response.arrayBuffer();

    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const afterRelease = await POST(request(JSON.stringify({ text: "After" })));
    expect(afterRelease.status).toBe(200);
    await afterRelease.arrayBuffer();
  });
});
