import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";

/**
 * The credential the BUILT server prints is the credential its own routes accept
 * (#691 round 9).
 *
 * This test exists because the round-8 fix passed every in-process test and did not
 * work. The secret was module state, and Next compiles the instrumentation entry and
 * each route handler into SEPARATE server bundles — seven copies of the module in the
 * built output, seven independent `let minted`. Startup printed one; `/api/bridge`
 * compared against another; `/api/orchestrator` against a third. The operator's own
 * key got a 403 from the operator-only route.
 *
 * No in-process test can see that. A test process loads the module once, so
 * `operatorSessionSecret()` and `matchesOperatorSession()` are guaranteed to agree —
 * which is exactly the guarantee that does not survive the build. The only witness is
 * the artifact itself: start the real server, take the key off its stdout, and present
 * it to a route.
 *
 * Kept out of `next build`'s way and off the shared machine: its own state root, its
 * own HOME, structured hosting rolled back so it adopts nothing, and an ephemeral port.
 */

const REPO = path.resolve(import.meta.dir, "..", "..", "..");
const BUILD_ID = path.join(REPO, ".next", "BUILD_ID");

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let stop: (() => void) | null = null;
afterAll(() => { stop?.(); });

/* The built server, its printed key, and the port it answers on. */
async function startBuiltViewer(): Promise<{ port: number; key: string }> {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-session-"));
  const child = Bun.spawn({
    cmd: [path.join(REPO, "node_modules", ".bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"],
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      TMPDIR: path.join(root, "tmp"),
      LLV_STATE_DIR: path.join(root, "state"),
      /* Adopt nothing, own nothing, reconcile nothing: this process is here to answer
         one request, and the machine it runs on has a live registry it must not touch. */
      LLV_STRUCTURED_HOSTS: "0",
      LLV_RUNTIME_EVENTS: "0",
      LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
      LLV_WAKATIME_ENABLED: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  stop = () => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  };

  /* The key is announced on the line after its label, on stderr, before the server
     reports ready. Both streams are read because a Next release moving the banner
     between them should not silently turn this into a timeout. */
  let seen = "";
  const decoder = new TextDecoder();
  const absorb = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) seen += decoder.decode(value, { stream: true });
    }
  };
  void absorb(child.stdout as ReadableStream<Uint8Array>);
  void absorb(child.stderr as ReadableStream<Uint8Array>);

  const deadline = Date.now() + 90_000;
  const keyLine = /\[viewer\] operator key \(paste it[^\n]*\n\[viewer\]\s+(\S+)/;
  while (Date.now() < deadline) {
    const match = keyLine.exec(seen);
    if (match) {
      /* Ready, not merely announced: the banner is printed from `register()`, which
         can run before the first request is servable. */
      for (let attempt = 0; attempt < 90; attempt += 1) {
        try {
          await fetch(`http://127.0.0.1:${port}/api/bridge?mode=turn-start`);
          return { port, key: match[1] };
        } catch {
          await Bun.sleep(250);
        }
      }
      throw new Error(`built server printed a key but never accepted a connection on ${port}`);
    }
    if (child.exitCode !== null) throw new Error(`built server exited ${child.exitCode}:\n${seen}`);
    await Bun.sleep(250);
  }
  throw new Error(`built server never printed an operator key:\n${seen}`);
}

const built = fs.existsSync(BUILD_ID);
const gated = built ? test : test.skip;
if (!built) {
  console.error("[operatorSession.builtServer] no .next/BUILD_ID — run `bun run build` first; this test is the only proof that survives bundling");
}

gated("the key the built server prints is the key its operator-only route accepts", async () => {
  const { port, key } = await startBuiltViewer();
  expect(key.length).toBeGreaterThan(20);

  /* THE REGRESSION. Round 8 failed exactly here: a 403 for the operator's own key,
     because the route bundle had minted a different one. */
  const accepted = await fetch(`http://127.0.0.1:${port}/api/bridge?mode=turn-start`, {
    headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: key },
  });
  expect(accepted.status).toBe(200);

  /* Presenting nothing, and presenting a well-formed impostor, are both refused — so
     the 200 above is the key doing the work and not an open door. */
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/bridge?mode=turn-start`);
  expect(anonymous.status).toBe(403);

  const impostor = await fetch(`http://127.0.0.1:${port}/api/bridge?mode=turn-start`, {
    headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: `${"a".repeat(key.length - 1)}b` },
  });
  expect(impostor.status).toBe(403);
}, 180_000);

gated("a SECOND operator-gated route accepts the same key — one secret per process, not per bundle", async () => {
  const { port, key } = await startBuiltViewer();

  /* `/api/orchestrator` is a different built bundle with its own copy of the module.
     Under module scope it minted a third secret, so this refused the key that
     `/api/bridge` had just accepted. Anything but 403 proves the gate resolved the
     same secret; the body is the route's own business. */
  const response = await fetch(`http://127.0.0.1:${port}/api/orchestrator`, {
    method: "POST",
    headers: { "content-type": "application/json", [VIEWER_SPAWN_CAPABILITY_HEADER]: key },
    body: JSON.stringify({}),
  });
  expect(response.status).not.toBe(403);

  const anonymous = await fetch(`http://127.0.0.1:${port}/api/orchestrator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(anonymous.status).toBe(403);
}, 180_000);
