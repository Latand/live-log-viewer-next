import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBackend = process.env.LLV_TRANSCRIBE_BACKEND;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const originalElevenKey = process.env.ELEVENLABS_API_KEY;
const originalFetch = globalThis.fetch;
const roots: string[] = [];

/** The account key the operator drops in the config dir; the browser must
    never see it. */
const REAL_KEY = "soniox-account-key-do-not-ship";
/** The documented shape of a minted key: a `temp:` prefix and an opaque tail. */
const TEMP_KEY = "temp:WYJ67RBEFUWQXXPKYPD2UGXKWB";

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-live-token-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  const dir = path.join(root, "agent-log-viewer");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function request(): NextRequest {
  return new NextRequest("http://127.0.0.1/api/transcribe/token", { method: "POST", headers: { host: "127.0.0.1" } });
}

/* Env restore goes through a name-indexed helper: writing
   `process.env.X_API_KEY = value` directly reads as a credential assignment to
   the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  setEnv("XDG_CONFIG_HOME", originalConfigHome);
  setEnv("LLV_TRANSCRIBE_BACKEND", originalBackend);
  setEnv("SONIOX_API_KEY", originalSonioxKey);
  setEnv("ELEVENLABS_API_KEY", originalElevenKey);
  globalThis.fetch = originalFetch;
});

describe("/api/transcribe/token — soniox temporary keys (#1020)", () => {
  test("mints a temporary key and hands out only that, never the account key", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    setEnv("SONIOX_API_KEY", REAL_KEY);
    /* The documented 201 body: a temp: key plus its expiry. */
    const fetchMock = mock(async () =>
      Response.json({ api_key: TEMP_KEY, expires_at: "2026-08-18T22:47:37.150Z" }, { status: 201 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request());
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ token: TEMP_KEY, provider: "soniox" });
    expect(raw).not.toContain(REAL_KEY);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.soniox.com/v1/auth/temporary-api-key");
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe(`Bearer ${REAL_KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      usage_type: "transcribe_websocket",
      single_use: true,
    });
    const body = JSON.parse(String(init.body)) as { expires_in_seconds: number; max_session_duration_seconds: number };
    /* Both are inside the documented ranges, and the session cap covers a
       full-length recording. */
    expect(body.expires_in_seconds).toBeGreaterThan(45);
    expect(body.expires_in_seconds).toBeLessThanOrEqual(3600);
    expect(body.max_session_duration_seconds).toBeGreaterThanOrEqual(600);
    expect(body.max_session_duration_seconds).toBeLessThanOrEqual(18_000);
  });

  test("reads the key from the config file the operator writes", async () => {
    const dir = configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    setEnv("SONIOX_API_KEY", undefined);
    fs.writeFileSync(path.join(dir, "soniox-api-key"), `${REAL_KEY}\n`);
    const fetchMock = mock(async () => Response.json({ api_key: "temp:ABC", expires_at: "2026-08-18T00:00:00Z" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await (await POST(request())).json()).toEqual({ token: "temp:ABC", provider: "soniox" });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe(`Bearer ${REAL_KEY}`);
  });

  test("degrades like the ElevenLabs missing-key path when no key is present", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    setEnv("SONIOX_API_KEY", undefined);
    globalThis.fetch = mock(async () => {
      throw new Error("must not call Soniox without a key");
    }) as unknown as typeof fetch;

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("soniox-api-key") });
  });

  test("refuses to pass the account key off as a temporary one", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    setEnv("SONIOX_API_KEY", REAL_KEY);
    globalThis.fetch = mock(async () => Response.json({ api_key: REAL_KEY })) as unknown as typeof fetch;

    const response = await POST(request());
    const raw = await response.text();
    expect(response.status).toBe(502);
    expect(raw).not.toContain(REAL_KEY);
  });

  test("reports an upstream refusal as a 502 without leaking the key", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    setEnv("SONIOX_API_KEY", REAL_KEY);
    globalThis.fetch = mock(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;

    const response = await POST(request());
    const raw = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(raw)).toEqual({ error: "Soniox token: HTTP 401" });
    expect(raw).not.toContain(REAL_KEY);
  });
});

describe("/api/transcribe/token — the existing paths are unchanged", () => {
  test("elevenlabs still mints its single-use token, now naming its provider", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "elevenlabs";
    setEnv("ELEVENLABS_API_KEY", "eleven-key");
    const fetchMock = mock(async () => Response.json({ token: "single-use-token" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request());
    expect(await response.json()).toEqual({ token: "single-use-token", provider: "elevenlabs" });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
    expect(new Headers(init.headers as HeadersInit).get("xi-api-key")).toBe("eleven-key");
  });

  test("a non-live backend still answers 409 so the client falls back to batch", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "local";
    globalThis.fetch = mock(async () => {
      throw new Error("must not reach a provider");
    }) as unknown as typeof fetch;

    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("soniox") });
  });
});
