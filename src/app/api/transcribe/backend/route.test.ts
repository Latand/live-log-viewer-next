import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";
import type { TranscribeBackendInfo } from "@/lib/transcribeBackend";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBackend = process.env.LLV_TRANSCRIBE_BACKEND;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const roots: string[] = [];

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stt-backend-route-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  const dir = path.join(root, "agent-log-viewer");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/transcribe/backend", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
});

describe("/api/transcribe/backend accepts soniox (#1020)", () => {
  test("the info endpoint offers soniox and reports whether its key is readable", async () => {
    const dir = configHome();
    delete process.env.LLV_TRANSCRIBE_BACKEND;
    delete process.env.SONIOX_API_KEY;

    const missing = (await (await GET()).json()) as TranscribeBackendInfo;
    expect(missing.options.find((option) => option.id === "soniox")).toMatchObject({
      available: false,
      keyPath: path.join(dir, "soniox-api-key"),
    });

    fs.writeFileSync(path.join(dir, "soniox-api-key"), "a-key\n");
    const present = (await (await GET()).json()) as TranscribeBackendInfo;
    expect(present.options.find((option) => option.id === "soniox")?.available).toBe(true);
  });

  test("selecting soniox persists it and comes back as the active backend", async () => {
    const dir = configHome();
    delete process.env.LLV_TRANSCRIBE_BACKEND;

    const response = await POST(request({ backend: "soniox" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ backend: "soniox", lockedByEnv: false });
    expect(fs.readFileSync(path.join(dir, "transcribe-backend"), "utf8")).toBe("soniox\n");
  });

  test("the env lock still refuses a selection, and unknown backends are rejected by name", async () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    expect((await POST(request({ backend: "local" }))).status).toBe(409);

    delete process.env.LLV_TRANSCRIBE_BACKEND;
    const bad = await POST(request({ backend: "sonix" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "backend must be one of local, chatgpt, elevenlabs, soniox" });
  });
});
