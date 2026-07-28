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
 * sentinel we invent — it is read out of the startup link the server itself prints,
 * so the value searched for is the value that actually grants authority.
 *
 * Verified to go red against the round-7 leak (`<Viewer operatorCredential={cap} />`)
 * before being kept.
 */

const BUILD_DIR = path.join(process.cwd(), ".next");
const built = fs.existsSync(path.join(BUILD_DIR, "BUILD_ID"));

let server: ReturnType<typeof Bun.spawn> | null = null;
let origin = "";
let sessionValue = "";
let sandbox = "";

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
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  /* The secret exists only in that process's memory; the startup link is the only
     place it is ever emitted, which is precisely the property under test. */
  const deadline = Date.now() + 60_000;
  const reader = (server.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (Date.now() < deadline && !sessionValue) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
    const match = /#llv-operator=([A-Za-z0-9_-]+)/.exec(seen);
    if (match) sessionValue = decodeURIComponent(match[1]!);
  }
  void reader.cancel().catch(() => undefined);

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

test("the startup link is the only place the session secret appears", () => {
  expect(sessionValue).toMatch(/^[A-Za-z0-9_-]{20,}$/);
});

test("an anonymously fetched document carries no operator secret", async () => {
  const response = await fetch(origin, { headers: { accept: "text/html" } });
  const html = await response.text();
  expect(html.length).toBeGreaterThan(0);
  expect(html).not.toContain(sessionValue);
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
