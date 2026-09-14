import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { decodeCodexStructuredUserText, encodeCodexStructuredUserText } from "./codexStructuredUserText";

/**
 * The real installed Codex app-server, with NO credentials at all (#1560).
 *
 * Everything else in this feature is proven against a hand-written double, and
 * a double proves only that the Viewer is consistent with what its author
 * believed. Two of this feature's claims are claims about the ENGINE, and they
 * are what this file settles against `codex app-server` itself:
 *
 * 1. `thread/inject_items` answers with an empty object.
 * 2. An idle injection is persisted to the rollout as a RAW Responses item —
 *    `{"type":"response_item","payload":{"type":"message","role":"user",…}}` —
 *    and starts no turn.
 *
 * Claim 2 is the one the Viewer's canonical scan depends on. If the engine ever
 * changes that shape, injections stop being observable and silently settle
 * `uncertain`; this test is what makes that a red build instead.
 *
 * WHY THIS IS SAFE TO RUN. Injection performs no sampling, so no request
 * reaches a provider: the run works with an EMPTY `CODEX_HOME` and never reads
 * or copies the operator's `auth.json`. That is deliberately unlike the
 * subscription integration suite beside it, which copies a real credential and
 * stays opt-in. Everything here happens under a private home that is removed
 * afterwards.
 *
 * It skips when `codex` is absent, which is why CI stays green without it.
 */

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";

function codexIsInstalled(): boolean {
  try {
    const probe = spawnSync(codexBinary, ["--version"], { encoding: "utf8", timeout: 15_000 });
    return probe.status === 0 && /codex/i.test(probe.stdout);
  } catch {
    return false;
  }
}

const installed = codexIsInstalled();
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

interface Probe {
  rpc(method: string, params?: Record<string, unknown>): Promise<{ result?: unknown; error?: { message?: string } }>;
  stop(): void;
}

function startAppServer(home: string): Probe {
  const child: ChildProcessWithoutNullStreams = spawn(codexBinary, ["app-server"], {
    /* An ALLOWLISTED environment with an empty CODEX_HOME: no credential is
       inherited, so nothing here can authenticate even by accident. */
    env: {
      HOME: home,
      NODE_ENV: process.env.NODE_ENV,
      CODEX_HOME: path.join(home, ".codex"),
      PATH: process.env.PATH,
      TMPDIR: home,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    },
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 0;
  const pending = new Map<number, (value: { result?: unknown; error?: { message?: string } }) => void>();
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = message.id;
      if (typeof id !== "number") continue;
      const resolve = pending.get(id);
      if (!resolve) continue;
      pending.delete(id);
      resolve(message.error ? { error: message.error as { message?: string } } : { result: message.result });
    }
  });
  child.stderr.resume();
  return {
    rpc: (method, params = {}) => new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (!pending.delete(id)) return;
        resolve({ error: { message: `${method} timed out` } });
      }, 20_000);
    }),
    stop: () => { child.kill("SIGKILL"); },
  };
}

function privateHome(): string {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "llv-inject-cli-"));
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
  homes.push(home);
  return home;
}

interface RolloutRecord {
  type?: string;
  payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
}

function readRollout(file: string): RolloutRecord[] {
  return fs.readFileSync(file, "utf8").trimEnd().split("\n")
    .map((line) => { try { return JSON.parse(line) as RolloutRecord; } catch { return null; } })
    .filter((record): record is RolloutRecord => record !== null);
}

test.skipIf(!installed)(
  "real Codex 0.154 acknowledges thread/inject_items with {} and persists a raw Responses user item, starting no turn",
  async () => {
    const home = privateHome();
    const probe = startAppServer(home);
    try {
      const initialized = await probe.rpc("initialize", { clientInfo: { name: "llv-inject-probe", version: "0" } });
      expect(initialized.error).toBeUndefined();

      const started = await probe.rpc("thread/start", {});
      expect(started.error).toBeUndefined();
      const thread = (started.result as { thread?: { id?: string; path?: string; status?: { type?: string } } }).thread;
      expect(thread?.id).toBeTruthy();
      expect(thread?.path).toBeTruthy();
      /* Idle before the injection, and it must still be idle after. */
      expect(thread?.status?.type).toBe("idle");

      /* The SAME envelope the Viewer writes, so what is asserted below is the
         record production actually produces — marker, authorship and all. */
      const dedup = "b".repeat(64);
      const wire = encodeCodexStructuredUserText(
        "probe: injected context line",
        undefined,
        undefined,
        { kind: "operator" },
        dedup,
      );
      const injected = await probe.rpc("thread/inject_items", {
        threadId: thread!.id,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text: wire }] }],
      });

      /* CLAIM 1: the acknowledgement is an empty object and carries no item id,
         no turn id, nothing that could settle a delivery. */
      expect(injected.error).toBeUndefined();
      expect(injected.result).toEqual({});

      /* The idle path flushes to the rollout; give it a moment to land. */
      const deadline = Date.now() + 10_000;
      let records: RolloutRecord[] = [];
      let ours: RolloutRecord | undefined;
      while (Date.now() < deadline) {
        records = fs.existsSync(thread!.path!) ? readRollout(thread!.path!) : [];
        ours = records.find((record) => record.payload?.content?.some((part) => part.text?.includes(dedup)));
        if (ours) break;
        await Bun.sleep(100);
      }

      /* CLAIM 2, and the one the Viewer's canonical scan is built on. */
      expect(ours).toBeDefined();
      expect(ours!.type).toBe("response_item");
      expect(ours!.payload?.type).toBe("message");
      expect(ours!.payload?.role).toBe("user");
      expect(ours!.payload?.content?.[0]?.type).toBe("input_text");

      /* And it round-trips through the Viewer's own decoder, so the marker the
         dedup check looks for survives the engine verbatim. */
      const decoded = decodeCodexStructuredUserText(ours!.payload!.content![0]!.text!);
      expect(decoded.deliveryDedup).toBe(dedup);
      expect(decoded.text).toBe("probe: injected context line");
      expect(decoded.origin).toEqual({ kind: "operator" });

      /* NO TURN WAS STARTED. The engine records a turn beginning as a
         `task_started` event; an idle injection produces none. */
      expect(records.some((record) => record.payload?.type === "task_started")).toBe(false);

      /* The same rollout carries developer-role records in the IDENTICAL
         shape, which is why the Viewer's scan filters on the role rather than
         on the record type alone. */
      expect(records.some((record) => record.payload?.type === "message" && record.payload?.role === "developer")).toBe(true);
    } finally {
      probe.stop();
    }
  },
  120_000,
);
