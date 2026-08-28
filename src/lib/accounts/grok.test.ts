import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { grokAuthStatus, grokHome } from "./grok";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-grok-auth-"));
const PREV_HOME = process.env.LLV_GROK_HOME;
const PREV_KEY = process.env.XAI_API_KEY;

function writeAuth(body: unknown) {
  process.env.LLV_GROK_HOME = SANDBOX;
  delete process.env.XAI_API_KEY;
  fs.writeFileSync(path.join(SANDBOX, "auth.json"), JSON.stringify(body));
}

afterEach(() => {
  if (PREV_HOME === undefined) delete process.env.LLV_GROK_HOME;
  else process.env.LLV_GROK_HOME = PREV_HOME;
  if (PREV_KEY === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = PREV_KEY;
  fs.rmSync(path.join(SANDBOX, "auth.json"), { force: true });
});

test("grokHome honours LLV_GROK_HOME", () => {
  process.env.LLV_GROK_HOME = SANDBOX;
  expect(grokHome()).toBe(path.resolve(SANDBOX));
});

test("a future expires_at is signed in", () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  writeAuth({
    "https://auth.example.invalid::session-alpha": {
      expires_at: expiresAt,
      key: "session-token-fixture",
    },
  });
  expect(grokAuthStatus()).toEqual({ signedIn: true, source: "session", expiresAt });
});

test("an expired session is signed out unless an API key is set", () => {
  writeAuth({
    "https://auth.example.invalid::session-alpha": {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      key: "session-token-fixture",
    },
  });
  expect(grokAuthStatus().signedIn).toBe(false);
  process.env.XAI_API_KEY = "xai-fixture";
  expect(grokAuthStatus()).toEqual({ signedIn: true, source: "api_key", expiresAt: null });
});

test("missing auth.json is signed out", () => {
  process.env.LLV_GROK_HOME = SANDBOX;
  delete process.env.XAI_API_KEY;
  expect(grokAuthStatus()).toEqual({ signedIn: false, source: null, expiresAt: null });
});
