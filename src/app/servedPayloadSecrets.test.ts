import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * THE REAL PRODUCTION BUILD HANDS NOBODY A CREDENTIAL — because there is none.
 *
 * This file has been wrong twice, in opposite directions, and both failures are why
 * it fetches from a real server instead of asserting about source:
 *
 * 1. Its first version called `renderToStaticMarkup(Home())`, which is not how Next
 *    serves anything. A credential passed as a PROP to a client component travels in
 *    the RSC flight payload, not in static markup, so the test passed against the
 *    exact leak it was written to prove gone.
 * 2. Its second version was written for the operator-key ceremony: it started the
 *    server with `LLV_OPERATOR_KEY_FD=3` and READ that descriptor until a key
 *    arrived. Startup emits no key any more, so nothing was ever written and nothing
 *    ever closed the write end — the read never resolved and the suite hung forever.
 *    A test that cannot terminate proves less than no test at all.
 *
 * What it proves now is the CURRENT invariant, which is stronger and simpler than
 * the one it replaced: the operator ceremony is gone, so there is no bearer to leak
 * into a document, a flight payload, a captured log, a build artifact or a
 * supervisor's descriptor. The descriptor is still opened — deliberately — because
 * "the supervisor channel stays SILENT" is exactly the regression that would fire if
 * key emission came back.
 *
 * Every read is bounded. Nothing here waits on a write that may never happen.
 */

const BUILD_DIR = path.join(process.cwd(), ".next");
const built = fs.existsSync(path.join(BUILD_DIR, "BUILD_ID"));

/** Shape of everything this app has ever called a credential: 32 random bytes,
    base64url. Searched for as a CLASS, because the point is that no such value
    exists to name. */
const CREDENTIAL_SHAPE = /[A-Za-z0-9_-]{43}/;

const START_TIMEOUT_MS = 45_000;

let server: ReturnType<typeof Bun.spawn> | null = null;
let origin = "";
let sandbox = "";
let supervisorChannel = "";
let capturedOutput = "";
/** The agent capability the server mints on disk. A real secret-shaped value that
    genuinely exists, so "no build artifact carries a secret" is asserted against
    something rather than against nothing. */
let spawnCapability = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Read whatever is available within a budget, then stop. Never waits for EOF: the
    child holds the write end of these pipes open for its whole life. */
async function readAvailable(stream: ReadableStream<Uint8Array> | null | undefined, budgetMs: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let seen = "";
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const),
      ]);
      if (chunk === "timeout") break;
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return seen;
}

beforeAll(async () => {
  if (!built) return;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-served-payload-"));
  const stateDir = path.join(sandbox, "state");
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  /* The SAME command `package.json` starts the viewer with, under the SAME Bun
     this file runs on. `bunx next start` hands the server to node, where the
     instrumentation hook dies on "SQLite state stores require the Bun runtime"
     — every request 500s and the assertions below read that error page instead
     of a served payload. A bare `bun` off PATH does the same thing whenever it
     is older than the image's pin, because the compiled app-page runtime does
     not load below Bun 1.4.0. `process.execPath` is the interpreter under
     test, which is the one whose answers this file is reading. */
  const runtime = process.versions.bun ? process.execPath : "bun";
  server = Bun.spawn([runtime, "--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      LLV_STATE_DIR: stateDir,
      HOME: sandbox,
      XDG_CONFIG_HOME: path.join(sandbox, ".config"),
      TMPDIR: path.join(sandbox, "tmp"),
      /* The channel the rejected ceremony wrote its key to. Opened here so the
         assertion below can prove it stays silent. */
      LLV_OPERATOR_KEY_FD: "3",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"] as never,
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(origin, { redirect: "manual" });
      if (probe.status > 0) break;
    } catch {
      await Bun.sleep(200);
    }
  }

  /* Everything the server said, and everything it handed the supervisor, both read
     with a budget so a silent channel costs a second rather than the suite. */
  const keyFd = (server as unknown as { stdio: (ReadableStream<Uint8Array> | number | null)[] }).stdio[3];
  supervisorChannel = typeof keyFd === "number"
    ? await readAvailable(Bun.file(keyFd).stream(), 1_000)
    : await readAvailable(keyFd as ReadableStream<Uint8Array>, 1_000);
  capturedOutput = [
    await readAvailable(server.stdout as ReadableStream<Uint8Array>, 1_000),
    await readAvailable(server.stderr as ReadableStream<Uint8Array>, 1_000),
  ].join("\n");

  const capabilityFile = path.join(stateDir, "operator-spawn-capability");
  spawnCapability = fs.existsSync(capabilityFile) ? fs.readFileSync(capabilityFile, "utf8").trim() : "";
});

afterAll(() => {
  server?.kill();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Fails loudly rather than skipping: a security regression test that quietly does
    nothing when the build is missing is false assurance in another costume. */
test("the production build exists, so this test can actually run", () => {
  expect(built).toBe(true);
});

test("the supervisor's descriptor receives NOTHING — no key is minted to hand over", () => {
  /* The regression that ends the ceremony: round 10 wrote a bearer here and told the
     operator to paste it. If key emission ever comes back, this is where it shows. */
  expect(supervisorChannel.trim()).toBe("");
  expect(supervisorChannel).not.toMatch(CREDENTIAL_SHAPE);
});

test("the startup says where to look and nothing about unlocking anything", () => {
  expect(capturedOutput).toContain("[viewer] Open http://127.0.0.1:");
  for (const ceremony of ["operator key", "paste", "unlock", "stand down"]) {
    expect(capturedOutput.toLowerCase()).not.toContain(ceremony);
  }
});

test("neither stdout nor stderr carries the agent capability", () => {
  /* stderr belongs to the container logging driver under a managed start, so a
     bearer written there is a bearer at rest in a file every same-uid process can
     read. The one credential-shaped value that still exists must not appear there. */
  expect(spawnCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(capturedOutput).not.toContain(spawnCapability);
});

test("an anonymously fetched document carries no credential and asks for none", async () => {
  const response = await fetch(origin, { headers: { accept: "text/html" } });
  const html = await response.text();

  /* Status first, and this is the third version of the mistake in the header: an
     error page contains none of the ceremony below either, so a server that 500s
     every route passes every assertion in this file. It says nothing about a
     credential — it says the document was never served. */
  expect(response.status).toBe(200);
  expect(html.length).toBeGreaterThan(0);
  /* The round-7 fragment name, the round-8 storage key, the round-9 prop, and the
     header an agent identifies itself with: a served document that mentions any of
     them is a document expecting a credential to arrive. */
  for (const ceremony of ["llv-operator", "llv.operator.capability", "operatorCredential", "x-viewer-spawn-capability"]) {
    expect(html).not.toContain(ceremony);
  }
  expect(html).not.toContain(spawnCapability);
});

test("the RSC flight payload carries no credential either", async () => {
  /* Where the round-7 leak actually lived: a prop handed to a client component is
     serialized here, never into the static markup this file once inspected. */
  const response = await fetch(origin, {
    headers: { rsc: "1", "next-router-state-tree": "%5B%22%22%2C%7B%7D%5D", accept: "text/x-component" },
  });
  const flight = await response.text();

  for (const ceremony of ["llv-operator", "operatorCredential", "x-viewer-spawn-capability"]) {
    expect(flight).not.toContain(ceremony);
  }
  expect(flight).not.toContain(spawnCapability);
});

test("no build artifact carries the per-process agent capability", () => {
  /* It is minted per state directory, so finding it baked into the build would mean
     a shipped artifact carries one machine's credential. */
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "cache") return [];
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
  for (const file of walk(path.join(BUILD_DIR, "server"))) {
    if (!/\.(js|json|html|rsc|txt)$/.test(file)) continue;
    expect(fs.readFileSync(file, "utf8")).not.toContain(spawnCapability);
  }
});

test("the retired legacy orchestrator route is absent from the real build", async () => {
  /* PRD #976 decision 6 removes the global entry completely. The production
     artifact proves that both former verbs now resolve to no route. */
  const designate = await fetch(`${origin}/api/orchestrator`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ conversationId: "conversation_served_payload_legacy", path: null }),
  });
  expect(designate.status).toBe(404);

  const status = await fetch(`${origin}/api/orchestrator`, { headers: { origin, "sec-fetch-site": "same-origin" } });
  expect(status.status).toBe(404);
});
