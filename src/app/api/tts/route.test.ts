import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const originalKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

function request(body: string): NextRequest {
  return new NextRequest("http://127.0.0.1/api/tts", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body,
  });
}

describe("/api/tts", () => {
  test("reports unavailable and returns a clean 501 without an API key", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await (await GET()).json()).toEqual({ available: false });
    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "text-to-speech is unavailable" });
  });

  test("streams the OpenAI audio response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
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
      voice: "cedar",
      input: "Read this answer.",
      response_format: "mp3",
    });
  });
});
