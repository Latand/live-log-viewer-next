import { afterEach, describe, expect, test } from "bun:test";

import { sonioxTranscribe } from "./soniox";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/* Stands in for the documented async flow (POST /v1/files → POST
   /v1/transcriptions → GET /v1/transcriptions/{id} → GET …/transcript), with
   the status sequence the caller has to poll through. */
function stubSoniox(options: { statuses?: string[]; transcript?: unknown; failAt?: string } = {}): Call[] {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? ["completed"])];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers as HeadersInit);
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (body instanceof FormData) body = { file: (body.get("file") as File | null)?.name ?? null };
    calls.push({ method, url, auth: headers.get("authorization"), body });

    if (options.failAt && url.includes(options.failAt) && method === "POST") {
      return new Response("upstream said no", { status: 402 });
    }
    if (url.endsWith("/v1/files") && method === "POST") return Response.json({ id: "file-1" }, { status: 201 });
    if (url.endsWith("/v1/transcriptions") && method === "POST") return Response.json({ id: "tr-1", status: "queued" });
    if (url.endsWith("/transcript")) return Response.json(options.transcript ?? { id: "tr-1", text: "Hello there" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    const status = statuses.shift() ?? "completed";
    return Response.json(
      status === "error" ? { status, error_message: "audio too short" } : { id: "tr-1", status },
    );
  }) as unknown as typeof fetch;
  return calls;
}

function dictation(): File {
  return new File([new Uint8Array([1, 2, 3])], "dictation.webm", { type: "audio/webm" });
}

describe("Soniox async transcription", () => {
  test("uploads, transcribes, reads the transcript and cleans both artifacts up", async () => {
    const calls = stubSoniox();

    expect(await sonioxTranscribe("real-key", dictation(), "en")).toEqual({ text: "Hello there" });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.soniox.com/v1/files",
      "POST https://api.soniox.com/v1/transcriptions",
      "GET https://api.soniox.com/v1/transcriptions/tr-1",
      "GET https://api.soniox.com/v1/transcriptions/tr-1/transcript",
      "DELETE https://api.soniox.com/v1/transcriptions/tr-1",
      "DELETE https://api.soniox.com/v1/files/file-1",
    ]);
    for (const call of calls) expect(call.auth).toBe("Bearer real-key");
    expect(calls[1]!.body).toEqual({ file_id: "file-1", model: "stt-async-v5", language_hints: ["en"] });
  });

  test("omits language hints when the request carried no language", async () => {
    const calls = stubSoniox();
    await sonioxTranscribe("real-key", dictation(), "");
    expect(calls[1]!.body).toEqual({ file_id: "file-1", model: "stt-async-v5" });
  });

  test("polls until the transcription completes", async () => {
    const calls = stubSoniox({ statuses: ["queued", "processing", "completed"] });
    expect(await sonioxTranscribe("real-key", dictation(), "en")).toEqual({ text: "Hello there" });
    expect(calls.filter((call) => call.url.endsWith("/transcriptions/tr-1") && call.method === "GET")).toHaveLength(3);
  });

  test("surfaces a failed transcription and still cleans up", async () => {
    const calls = stubSoniox({ statuses: ["error"] });
    await expect(sonioxTranscribe("real-key", dictation(), "en")).rejects.toThrow("audio too short");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  test("surfaces an upstream HTTP failure with its status and body", async () => {
    stubSoniox({ failAt: "/v1/files" });
    await expect(sonioxTranscribe("bad-key", dictation(), "en")).rejects.toThrow("upload: HTTP 402 — upstream said no");
  });

  test("falls back to joining tokens when the transcript carries no text field", async () => {
    stubSoniox({ transcript: { id: "tr-1", tokens: [{ text: "Hel" }, { text: "lo" }, { text: " there" }] } });
    expect(await sonioxTranscribe("real-key", dictation(), "en")).toEqual({ text: "Hello there" });
  });
});
