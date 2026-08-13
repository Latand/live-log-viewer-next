import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { adoptOrchestratorRecord } from "@/lib/orchestrator/store";

import { GET } from "./route";

/* PRD #976 slice D (issue #980): the designation half of this route is gone with
   the Overview chat button, so what is left to cover is the READ the browser's
   `managerIdentity` still makes. The record is seeded through the store — the
   same way seat activation writes it via `syncLegacyRecord` — because no HTTP
   caller may write it any more. */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orchestrator-route-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("GET reports the empty slot", async () => {
  const body = await (await GET()).json();
  expect(body).toEqual({ record: null, exists: false, defaultCwd: process.cwd() });
});

test("GET names the recorded manager while its transcript is on disk", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: transcript, createdAt: new Date().toISOString() });

  const status = await (await GET()).json();
  expect(status).toMatchObject({ record: { conversationId: "conversation_manager", path: transcript }, exists: true });
});

test("GET flags a deleted transcript, so nothing downstream treats it as a live manager", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, "", "utf8");
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: transcript, createdAt: new Date().toISOString() });
  fs.rmSync(transcript);

  const status = await (await GET()).json();
  expect(status).toMatchObject({ record: { conversationId: "conversation_manager" }, exists: false });
});

test("the module exports no POST — the legacy designation entry is retired", async () => {
  const routeModule = await import("./route") as Record<string, unknown>;
  expect(routeModule.POST).toBeUndefined();
});
