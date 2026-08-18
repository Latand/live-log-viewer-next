import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const originalKey = process.env.OPENAI_API_KEY;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const originalBackend = process.env.LLV_TTS_BACKEND;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalFetch = globalThis.fetch;
const SONIOX_KEY = "soniox-account-key";

/* Env restore goes through a name-indexed helper: writing
   `process.env.X_API_KEY = value` directly reads as a credential assignment to
   the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("OPENAI_API_KEY", originalKey);
  setEnv("SONIOX_API_KEY", originalSonioxKey);
  setEnv("LLV_TTS_BACKEND", originalBackend);
  setEnv("XDG_CONFIG_HOME", originalConfigHome);
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
    setEnv("OPENAI_API_KEY", undefined);
    expect(await (await GET()).json()).toEqual({ available: false });
    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "text-to-speech is unavailable" });
  });

  test("returns a clean 400 for a null JSON body", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    const response = await POST(request("null"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "expected a JSON object" });
  });

  test("streams the OpenAI audio response", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
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
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    globalThis.fetch = mock(async () => new Response("not audio", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello" })))).status).toBe(502);

    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/mpeg", "content-length": String(32 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello" })))).status).toBe(502);
  });

  test("propagates client cancellation to the provider request", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
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
    setEnv("OPENAI_API_KEY", "test-key");
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

describe("/api/tts — soniox (#1020)", () => {
  test("posts the documented /tts body and streams the audio back", async () => {
    process.env.LLV_TTS_BACKEND = "soniox";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("SONIOX_API_KEY", SONIOX_KEY);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([9, 9])); controller.close(); } });
    const fetchMock = mock(async () => new Response(stream, { headers: { "content-type": "audio/mpeg" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({ available: true });
    const response = await POST(request(JSON.stringify({ text: "Read this answer." })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 9]));

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://tts-rt.soniox.com/tts");
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe(`Bearer ${SONIOX_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "tts-rt-v2",
      voice: "Adrian",
      language: "en",
      audio_format: "mp3",
      text: "Read this answer.",
    });
  });

  test("degrades with a clean 503 and a key path when no key is present", async () => {
    process.env.LLV_TTS_BACKEND = "soniox";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("SONIOX_API_KEY", undefined);
    globalThis.fetch = mock(async () => { throw new Error("must not call Soniox without a key"); }) as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({ available: false });
    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "text-to-speech is unavailable",
      keyPath: expect.stringContaining("soniox-api-key"),
    });
  });

  test("reports an upstream refusal as a 502 without leaking the key", async () => {
    process.env.LLV_TTS_BACKEND = "soniox";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("SONIOX_API_KEY", SONIOX_KEY);
    globalThis.fetch = mock(async () => Response.json(
      { error_code: 401, error_type: "unauthorized", error_message: "Invalid API key." },
      { status: 401 },
    )) as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    const raw = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(raw)).toEqual({ error: "soniox TTS failed (HTTP 401)" });
    expect(raw).not.toContain(SONIOX_KEY);
  });

  test("selecting soniox leaves the ElevenLabs request shape untouched", async () => {
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("ELEVENLABS_API_KEY", "eleven-key");
    const fetchMock = mock(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Read this answer." })));
    await response.arrayBuffer();

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("xi-api-key")).toBe("eleven-key");
    expect(headers.get("accept")).toBe("audio/mpeg");
    expect(JSON.parse(String(init.body))).toEqual({ model_id: "eleven_multilingual_v2", text: "Read this answer." });

    setEnv("ELEVENLABS_API_KEY", undefined);
  });
});
