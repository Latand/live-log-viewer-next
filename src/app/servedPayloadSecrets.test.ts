import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Nothing a local process can FETCH may carry operator authority.
 *
 * THE FIRST VERSION OF THIS FILE WAS WORSE THAN NOTHING. It called
 * `renderToStaticMarkup(Home())`, which is not how Next serves anything: a credential
 * passed as a PROP to a client component travels in the RSC flight payload, not in
 * static markup, so the test passed against the exact leak it was written to prove
 * gone. A regression test that cannot reproduce its own bug converts an open question
 * into false assurance, which is the worse of the two states.
 *
 * So this one fetches from a REAL SERVER: the production build, started on an
 * ephemeral port, asked for the document and for the RSC payload. The secret is not a
 * sentinel we invent — it is read out of the startup banner the server itself prints,
 * so the value searched for is the value that actually grants authority.
 *
 * Verified to go red against the round-7 leak (`<Viewer operatorCredential={cap} />`)
 * before being kept.
 *
 * Round 9 changed what the banner looks like — the key is printed bare, because the
 * round-7 clickable link put it in a URL and Chromium writes URLs to a History
 * database on disk. The parse follows the banner rather than the other way round.
 */

const BUILD_DIR = path.join(process.cwd(), ".next");
const built = fs.existsSync(path.join(BUILD_DIR, "BUILD_ID"));

let server: ReturnType<typeof Bun.spawn> | null = null;
let origin = "";
let sessionValue = "";
let sandbox = "";
let capturedOutput: () => string = () => "";

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

beforeAll(async () => {
  if (!built) return;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-served-payload-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bunx", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      LLV_STATE_DIR: path.join(sandbox, "state"),
      HOME: sandbox,
      XDG_CONFIG_HOME: path.join(sandbox, ".config"),
      /* ROUND 10: the key is no longer printed to stderr, because stderr is captured
         and persisted by the managed start. It goes to the controlling terminal, or —
         as here — to a supervisor's descriptor. This test IS that supervisor. */
      LLV_OPERATOR_KEY_FD: "3",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"] as never,
  });

  const deadline = Date.now() + 45_000;
  const keyFd = (server as unknown as { stdio: (number | null)[] }).stdio[3];
  const capturedStreams: string[] = [];

  /* Read the key off the private descriptor — the FIRST LINE only. Reading to EOF
     would block until the server exits, because it holds the write end open. */
  if (typeof keyFd === "number") {
    const reader = Bun.file(keyFd).stream().getReader();
    const decoder = new TextDecoder();
    let handed = "";
    while (Date.now() < deadline && !handed.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      handed += decoder.decode(chunk.value, { stream: true });
    }
    void reader.cancel().catch(() => undefined);
    sessionValue = handed.split("\n")[0]!.trim();
  }

  /* And keep everything the process wrote to its CAPTURED streams, so the assertions
     below can prove the key is not in them. */
  const drain = async (stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> => {
    if (!stream) return;
    capturedStreams.push(await new Response(stream).text().catch(() => ""));
  };
  void drain(server.stdout as ReadableStream<Uint8Array>);
  void drain(server.stderr as ReadableStream<Uint8Array>);
  capturedOutput = () => capturedStreams.join("\n");

  while (Date.now() < deadline) {
    try {
      const probe = await fetch(origin, { redirect: "manual" });
      if (probe.status > 0) break;
    } catch {
      await Bun.sleep(200);
    }
  }
});

afterAll(() => {
  server?.kill();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Fails loudly rather than skipping: a security regression test that quietly does
    nothing when the build is missing is the same false assurance in another costume. */
test("the production build exists, so this test can actually run", () => {
  expect(built).toBe(true);
});

test("the key reaches the supervisor's descriptor, not a captured stream", () => {
  expect(sessionValue).toMatch(/^[A-Za-z0-9_-]{20,}$/);
});

test("neither stdout nor stderr carries the key", async () => {
  /* The round-10 finding: stderr belongs to the container logging driver, so a key
     written there is a bearer at rest in a log file that every same-uid process can
     read. Give the streams a moment to flush, then look. */
  await Bun.sleep(300);
  const captured = capturedOutput();
  expect(captured).not.toContain(sessionValue);
});

test("an anonymously fetched document carries no operator secret", async () => {
  const response = await fetch(origin, { headers: { accept: "text/html" } });
  const html = await response.text();
  expect(html.length).toBeGreaterThan(0);
  expect(html).not.toContain(sessionValue);
  /* The round-7 fragment name must not come back: its presence in a served document
     would mean the page is once again expecting a credential to arrive through a URL. */
  expect(html).not.toContain("llv-operator");
});

test("the RSC flight payload carries no operator secret", async () => {
  /* Where the round-7 leak actually lived: a prop handed to a client component is
     serialized here, never into the static markup the first version of this test
     inspected. */
  const response = await fetch(origin, {
    headers: { rsc: "1", "next-router-state-tree": "%5B%22%22%2C%7B%7D%5D", accept: "text/x-component" },
  });
  const flight = await response.text();
  expect(flight).not.toContain(sessionValue);
  expect(flight).not.toContain("operatorCredential");
});

test("no build artifact on disk carries the session secret either", () => {
  /* It is minted per process, so it must not have been baked in. */
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "cache") return [];
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
  for (const file of walk(path.join(BUILD_DIR, "server"))) {
    if (!/\.(js|json|html|rsc|txt)$/.test(file)) continue;
    expect(fs.readFileSync(file, "utf8")).not.toContain(sessionValue);
  }
});
