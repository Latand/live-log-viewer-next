import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";

import { viewerHealthRequestPlan } from "./deploymentHealth";

import { proxy as viewerGate } from "@/proxy";

import { viewerComposeSnapshotPath } from "./deploymentArtifacts";
import {
  isLoopbackHost,
  parseViewerGatewayConfig,
  readViewerGatewayConfig,
  serveViewerDeploymentProxy,
  serveViewerLocalEntry,
  viewerReleaseCredentialResolver,
} from "./deploymentProxy";

async function listen(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return address.port;
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Every socket a server accepts, so a test can dispose of them itself. Bun
    1.4.0 never reports `end` or `close` on a raw socket the proxy already
    ended when its peer then closes, and `server.close()` waits for that
    report forever; the fixture owns the teardown instead of the runtime. */
function ownAccepted(server: net.Server): { destroyAll: () => void } {
  const accepted = new Set<net.Socket>();
  server.on("connection", (socket) => {
    accepted.add(socket);
    socket.once("close", () => accepted.delete(socket));
  });
  return { destroyAll: () => { for (const socket of accepted) socket.destroy(); } };
}

async function request(port: number): Promise<string> {
  const { stdout } = await promisify(execFile)("curl", [
    "--http1.1",
    "--include",
    "--max-time", "3",
    "--silent",
    "--show-error",
    `http://127.0.0.1:${port}/`,
  ]);
  return stdout;
}

test("deployment proxy forwards an immediate request through a real TCP connection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llv-deployment-proxy-"));
  const targetFile = path.join(directory, "viewer-release.json");
  const upstream = net.createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\r\n\r\n")) return;
      socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 7\r\n\r\nproxied");
    });
  });
  const upstreamSockets = ownAccepted(upstream);
  const upstreamPort = await listen(upstream);
  await fs.writeFile(targetFile, JSON.stringify({
    revision: "abc123",
    image: "viewer:test",
    container: "viewer-test",
    endpoint: `http://127.0.0.1:${upstreamPort}`,
  }));

  const proxy = serveViewerDeploymentProxy(targetFile, 0);
  const proxySockets = ownAccepted(proxy);
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy did not bind a TCP port");

  try {
    const response = await request(proxyAddress.port);
    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toEndWith("proxied");
  } finally {
    proxySockets.destroyAll();
    upstreamSockets.destroyAll();
    await close(proxy);
    await close(upstream);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a failed write on the stable listener ends the connection, not the runtime host", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llv-deployment-proxy-"));
  // No release target: the connection is answered with a raw 503 write, the
  // path that carried no error handling at all before #1254.
  const proxy = serveViewerDeploymentProxy(path.join(directory, "viewer-release.json"), 0);
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");

  try {
    const accepted = once(proxy, "connection") as Promise<[net.Socket]>;
    const client = net.createConnection(address.port, "127.0.0.1");
    client.on("error", () => undefined);
    const [downstream] = await accepted;

    const epipe = Object.assign(new Error("write EPIPE"), { errno: -32, code: "EPIPE", syscall: "write" });
    expect(() => downstream.emit("error", epipe)).not.toThrow();
    expect(downstream.destroyed).toBe(true);
    // A socket can fail more than once; the second report must stay handled.
    expect(() => downstream.emit("error", epipe)).not.toThrow();

    client.destroy();
  } finally {
    await close(proxy);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ */
/* The Viewer gateway (#1547): two real loopback listeners in front of the   */
/* Viewer's real gate.                                                       */
/* ------------------------------------------------------------------------ */

const originalToken = process.env.LLV_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = originalToken;
});

/** Whether this interpreter's node:http reports a downstream that went away
    and hands Upgrade sockets over writable. The image pins 1.4.0, which does
    both; 1.3.3 does neither, and the runtime host never runs there. */
const pinnedInterpreterBehaviour = Bun.semver.satisfies(Bun.version, ">=1.4.0");

interface Seen {
  method: string;
  path: string;
  host: string | undefined;
  /** The gate admitted the request on the release credential this Viewer enforces. */
  vouched: boolean;
  body: string;
}

interface GatedViewer {
  port: number;
  seen: Seen[];
  /** Resolves once a streaming response saw its downstream go away. */
  streamClosed: Promise<void>;
  close: () => Promise<void>;
}

/** A Viewer that is the real gate (`src/proxy.ts`) over node:http, answering
    JSON about what it saw, or a two-chunk stream on `/stream`. */
async function gatedViewer(token: string): Promise<GatedViewer> {
  process.env.LLV_TOKEN = token;
  const seen: Seen[] = [];
  let markStreamClosed = () => undefined as void;
  const streamClosed = new Promise<void>((resolve) => { markStreamClosed = resolve; });
  const server = http.createServer(async (incoming, outgoing) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
      else if (value !== undefined) headers.set(name, value);
    }
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const decision = viewerGate(new NextRequest(`http://${incoming.headers.host ?? "viewer"}${incoming.url ?? "/"}`, { headers }));
    const admitted = decision.headers.get("x-middleware-next") === "1";
    seen.push({
      method: incoming.method ?? "",
      path: incoming.url ?? "",
      host: incoming.headers.host,
      vouched: admitted && incoming.headers.authorization === `Bearer ${token}`,
      body,
    });
    if (!admitted) {
      outgoing.writeHead(decision.status, Object.fromEntries(decision.headers));
      outgoing.end(Buffer.from(await decision.arrayBuffer()));
      return;
    }
    if (incoming.url?.startsWith("/stream")) {
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.write("data: first\n\n");
      const ticker = setInterval(() => outgoing.write("data: tick\n\n"), 40);
      outgoing.on("close", () => { clearInterval(ticker); markStreamClosed(); });
      if (incoming.url === "/stream") setTimeout(() => { clearInterval(ticker); outgoing.end("data: last\n\n"); }, 250);
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ path: incoming.url, method: incoming.method }));
  });
  const port = await listen(server);
  return { port, seen, streamClosed, close: () => close(server) };
}

interface Gateway {
  stateDir: string;
  gatewayFile: string;
  token: string;
  viewer: GatedViewer;
  reported: string[];
  local: http.Server;
  localPort: number;
  remote: net.Server;
  remotePort: number;
  configure: (config: unknown) => Promise<void>;
  close: () => Promise<void>;
}

/** Both entries on ephemeral ports, a release target naming the gated Viewer,
    its Compose snapshot carrying the credential, and the gateway file. */
async function gateway(options: { localEntry?: "trusted" | "authenticated"; credential?: "snapshot" | "none" } = {}): Promise<Gateway> {
  const token = randomBytes(16).toString("hex");
  const viewer = await gatedViewer(token);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-viewer-gateway-"));
  const container = "llv-deploy-gateway-test";
  await fs.writeFile(path.join(stateDir, "viewer-release.json"), JSON.stringify({
    revision: "abc123",
    image: "viewer:test",
    container,
    endpoint: `http://127.0.0.1:${viewer.port}`,
  }));
  if (options.credential !== "none") {
    const snapshot = viewerComposeSnapshotPath(stateDir, container);
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, JSON.stringify({ services: { viewer: { environment: { LLV_TOKEN: token } } } }));
  }
  const gatewayFile = path.join(stateDir, "viewer-gateway.json");
  const configure = async (config: unknown) => {
    const staged = `${gatewayFile}.next`;
    await fs.writeFile(staged, typeof config === "string" ? config : JSON.stringify(config));
    await fs.rename(staged, gatewayFile);
  };
  const remote = serveViewerDeploymentProxy(path.join(stateDir, "viewer-release.json"), 0);
  const remoteSockets = ownAccepted(remote);
  await once(remote, "listening");
  const remoteAddress = remote.address();
  if (!remoteAddress || typeof remoteAddress === "string") throw new Error("remote entry did not bind a TCP port");
  const remotePort = remoteAddress.port;
  await configure({ remoteEntryPort: remotePort, localEntry: options.localEntry ?? "trusted" });
  const reported: string[] = [];
  /* The local entry's own port is only known after listen, and the parser
     refuses a remote port equal to it; port 0 here never equals a bound one. */
  const local = serveViewerLocalEntry(path.join(stateDir, "viewer-release.json"), 0, "127.0.0.1", {
    gatewayFile,
    releaseCredential: viewerReleaseCredentialResolver(stateDir, {}),
    report: (line) => reported.push(line),
  });
  await once(local, "listening");
  const localAddress = local.address();
  if (!localAddress || typeof localAddress === "string") throw new Error("local entry did not bind a TCP port");
  return {
    stateDir, gatewayFile, token, viewer, reported, local, localPort: localAddress.port, remote, remotePort, configure,
    close: async () => {
      await close(local);
      remoteSockets.destroyAll();
      await close(remote);
      await viewer.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    },
  };
}

interface Answer { status: number; head: string; body: string; connects: number }

async function curl(port: string | number, pathname: string, ...args: string[]): Promise<Answer> {
  const { stdout } = await promisify(execFile)("curl", [
    "--http1.1", "--include", "--silent", "--show-error", "--max-time", "5",
    "--write-out", "\n%{num_connects}",
    ...args,
    `http://127.0.0.1:${port}${pathname}`,
  ]);
  const connects = Number(stdout.slice(stdout.lastIndexOf("\n") + 1));
  const raw = stdout.slice(0, stdout.lastIndexOf("\n"));
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split);
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
  return { status, head, body: raw.slice(split + 4), connects };
}

test("gateway configuration: no file is the default, and anything not a configuration is refused as a whole", () => {
  expect(parseViewerGatewayConfig(null, 8898)).toEqual({ present: false, config: { remoteEntryPort: null, localEntry: "authenticated" }, problem: null });
  expect(parseViewerGatewayConfig(JSON.stringify({ remoteEntryPort: 8897, localEntry: "trusted" }), 8898)).toEqual({
    present: true, config: { remoteEntryPort: 8897, localEntry: "trusted" }, problem: null,
  });
  expect(parseViewerGatewayConfig(JSON.stringify({ remoteEntryPort: 8897 }), 8898).config.localEntry).toBe("authenticated");
  for (const [raw, problem] of [
    ["{", "not valid JSON"],
    ["[]", "not a JSON object"],
    [JSON.stringify({ remoteEntryPort: 8897, localEntry: "trusted", open: true }), "unknown key"],
    [JSON.stringify({ remoteEntryPort: 8897, localEntry: "open" }), "localEntry must be"],
    [JSON.stringify({ remoteEntryPort: "8897" }), "remoteEntryPort must be"],
    [JSON.stringify({ remoteEntryPort: 8898, localEntry: "trusted" }), "is the local entry port"],
  ] as const) {
    const reading = parseViewerGatewayConfig(raw, 8898);
    expect(reading.problem).toContain(problem);
    // A partially valid file must not keep the half that parsed.
    expect(reading.config).toEqual({ remoteEntryPort: null, localEntry: "authenticated" });
  }
  expect(readViewerGatewayConfig(path.join(os.tmpdir(), `llv-no-such-gateway-${process.pid}.json`), 8898).present).toBe(false);

  for (const host of ["127.0.0.1", "127.0.0.1:8898", "localhost", "LOCALHOST:8898", "[::1]", "[::1]:8898"]) expect(isLoopbackHost(host)).toBe(true);
  for (const host of [undefined, "", "attacker.example", "attacker.example:8898", "127.0.0.1.attacker.example", "localhost.attacker.example", "203.0.113.7:8898", "::1"]) {
    expect(isLoopbackHost(host)).toBe(false);
  }
});

test("the release credential comes from the release container's Compose snapshot, then the host's own environment", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-viewer-credential-"));
  try {
    const target = { revision: "r", image: "i", container: "llv-deploy-credential-test", endpoint: "http://127.0.0.1:1" };
    expect(viewerReleaseCredentialResolver(stateDir, {})(target)).toBeNull();
    expect(viewerReleaseCredentialResolver(stateDir, { LLV_TOKEN: "from-environment" })(target)).toBe("from-environment");
    const snapshot = viewerComposeSnapshotPath(stateDir, target.container);
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await fs.writeFile(snapshot, JSON.stringify({ services: { viewer: { environment: { LLV_TOKEN: "from-snapshot" } } } }));
    expect(viewerReleaseCredentialResolver(stateDir, { LLV_TOKEN: "from-environment" })(target)).toBe("from-snapshot");
    // A release that names no token is a Viewer without a gate: nothing to vouch with.
    await fs.writeFile(snapshot, JSON.stringify({ services: { viewer: { environment: {} } } }));
    expect(viewerReleaseCredentialResolver(stateDir, { LLV_TOKEN: "from-environment" })(target)).toBeNull();
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("the trusted local entry admits a plain loopback request, replaces a stale key, and decides every request on a kept-alive connection", async () => {
  const entry = await gateway();
  try {
    const plain = await curl(entry.localPort, "/api/files");
    expect(plain.status).toBe(200);
    expect(entry.viewer.seen.at(-1)).toMatchObject({ path: "/api/files", host: `127.0.0.1:${entry.localPort}`, vouched: true });

    const stale = await curl(entry.localPort, "/api/files", "-H", "Authorization: Bearer stale");
    expect(stale.status).toBe(200);
    expect(entry.viewer.seen.at(-1)?.vouched).toBe(true);

    // One curl, two URLs: the second request rides the first connection.
    const { stdout } = await promisify(execFile)("curl", [
      "--http1.1", "--silent", "--show-error", "--max-time", "5",
      "--output", "/dev/null", "--output", "/dev/null",
      "--write-out", "%{http_code} %{num_connects}\n",
      `http://127.0.0.1:${entry.localPort}/first`, `http://127.0.0.1:${entry.localPort}/second`,
    ]);
    expect(stdout).toBe("200 1\n200 0\n");
    expect(entry.viewer.seen.slice(-2).map((seen) => [seen.path, seen.vouched])).toEqual([["/first", true], ["/second", true]]);
    expect(entry.reported).toEqual([]);
  } finally {
    await entry.close();
  }
});

test("the trusted local entry vouches only for a Host that names loopback: a DNS-rebound page is refused by the Viewer's gate", async () => {
  const entry = await gateway();
  try {
    for (const host of ["attacker.example", "attacker.example:8898", "127.0.0.1.attacker.example"]) {
      const rebound = await curl(entry.localPort, "/api/files", "-H", `Host: ${host}`);
      expect(rebound.status).toBe(403);
      expect(entry.viewer.seen.at(-1)).toMatchObject({ host, vouched: false });
    }
    // The port in Host is whatever the browser dialled; the name is what matters.
    const otherPort = await curl(entry.localPort, "/api/files", "-H", "Host: localhost:8898");
    expect(otherPort.status).toBe(200);
    expect(entry.viewer.seen.at(-1)).toMatchObject({ host: "localhost:8898", vouched: true });
  } finally {
    await entry.close();
  }
});

test("the remote entry rejects an unauthenticated request whatever local identity its headers forge", async () => {
  const entry = await gateway();
  try {
    const forged = await curl(
      entry.remotePort, "/api/files",
      "-H", "Host: 127.0.0.1:8898",
      "-H", "X-Forwarded-For: 127.0.0.1",
      "-H", "X-Real-IP: 127.0.0.1",
      "-H", "Forwarded: for=127.0.0.1;host=127.0.0.1:8898",
      "-H", "X-Forwarded-Host: localhost",
      "-H", "Cookie: llv_auth=not-the-key",
    );
    expect(forged.status).toBe(403);
    expect(entry.viewer.seen.at(-1)).toMatchObject({ path: "/api/files", vouched: false });

    const page = await curl(entry.remotePort, "/", "-H", "Host: 127.0.0.1:8898");
    expect(page.status).toBe(403);
    expect(page.body).toContain("Access denied");
    expect(page.body).not.toContain(entry.token);
  } finally {
    await entry.close();
  }
});

test("the remote entry admits the Viewer's own credentials: bearer, cookie, and the ?k= link that mints the cookie", async () => {
  const entry = await gateway();
  try {
    const bearer = await curl(entry.remotePort, "/api/files", "-H", `Authorization: Bearer ${entry.token}`);
    expect(bearer.status).toBe(200);

    const cookie = await curl(entry.remotePort, "/api/files", "-H", `Cookie: llv_auth=${entry.token}`);
    expect(cookie.status).toBe(200);

    const link = await curl(entry.remotePort, `/?k=${entry.token}`);
    expect(link.status).toBe(307);
    expect(link.head).toMatch(/set-cookie: llv_auth=/i);
    expect(link.head).toMatch(/location: [^\r\n]*\/\r?$|location: [^\r\n]*\/$/im);
    expect(/location: [^\r\n]*k=/i.test(link.head)).toBe(false);
  } finally {
    await entry.close();
  }
});

test("the local entry fails closed and flips live: authenticated, unreadable, unknown, or credential-less gateways all leave the gate in charge", async () => {
  const entry = await gateway({ localEntry: "authenticated" });
  try {
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);
    expect(entry.viewer.seen.at(-1)?.vouched).toBe(false);
    // The caller's own credential still travels through an authenticated entry.
    expect((await curl(entry.localPort, "/api/files", "-H", `Authorization: Bearer ${entry.token}`)).status).toBe(200);

    await entry.configure("{ not json");
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);
    expect(entry.reported.filter((line) => line.includes("not valid JSON"))).toHaveLength(1);
    // Dozens of requests, one line.
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);
    expect(entry.reported.filter((line) => line.includes("not valid JSON"))).toHaveLength(1);

    await entry.configure({ remoteEntryPort: entry.remotePort, localEntry: "open" });
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);

    await entry.configure({ remoteEntryPort: entry.remotePort, localEntry: "trusted", extra: 1 });
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);

    // Trusted, no restart, the next request is admitted.
    await entry.configure({ remoteEntryPort: entry.remotePort, localEntry: "trusted" });
    expect((await curl(entry.localPort, "/api/files")).status).toBe(200);
    expect(entry.viewer.seen.at(-1)?.vouched).toBe(true);

    // And withdrawn the same way.
    await entry.configure({ remoteEntryPort: entry.remotePort, localEntry: "authenticated" });
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);

    for (const line of entry.reported) expect(line).not.toContain(entry.token);
  } finally {
    await entry.close();
  }
});

test("a trusted local entry with no known release credential stays authenticated and says so once", async () => {
  const entry = await gateway({ credential: "none" });
  try {
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);
    expect((await curl(entry.localPort, "/api/files")).status).toBe(403);
    expect(entry.reported).toHaveLength(1);
    expect(entry.reported[0]).toContain("no credential is known");
  } finally {
    await entry.close();
  }
});

test("methods, bodies and streamed responses cross the vouched entry unchanged", async () => {
  const entry = await gateway();
  try {
    const body = "x".repeat(3000);
    const posted = await curl(entry.localPort, "/api/spawn", "-X", "POST", "-H", "Content-Type: text/plain", "--data-binary", body);
    expect(posted.status).toBe(200);
    expect(entry.viewer.seen.at(-1)).toMatchObject({ method: "POST", path: "/api/spawn", vouched: true, body });

    const head = await curl(entry.localPort, "/api/files", "--head");
    expect(head.status).toBe(200);
    expect(entry.viewer.seen.at(-1)?.method).toBe("HEAD");

    // Each chunk arrives as the Viewer writes it, well before the stream ends.
    const arrivals = await new Promise<number[]>((resolve, reject) => {
      const started = Date.now();
      const stamps: number[] = [];
      let text = "";
      http.get({ host: "127.0.0.1", port: entry.localPort, path: "/stream" }, (response) => {
        expect(response.statusCode).toBe(200);
        response.on("data", (chunk: Buffer) => { stamps.push(Date.now() - started); text += chunk; });
        response.on("end", () => {
          expect(text.startsWith("data: first\n\n")).toBe(true);
          expect(text.endsWith("data: last\n\n")).toBe(true);
          resolve(stamps);
        });
      }).on("error", reject);
    });
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect(arrivals[0]).toBeLessThan(150);
    expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThanOrEqual(150);
  } finally {
    await entry.close();
  }
});

test.skipIf(!pinnedInterpreterBehaviour)("a downstream that walks away mid-stream takes its Viewer request with it, and the entry keeps serving", async () => {
  const entry = await gateway();
  try {
    await new Promise<void>((resolve) => {
      const client = net.createConnection({ host: "127.0.0.1", port: entry.localPort }, () => {
        client.write(`GET /stream/forever HTTP/1.1\r\nHost: 127.0.0.1:${entry.localPort}\r\n\r\n`);
      });
      let received = "";
      client.on("data", (chunk) => {
        received += chunk;
        if (received.includes("data: first")) client.destroy();
      });
      client.on("error", () => undefined);
      client.once("close", resolve);
    });
    await Promise.race([
      entry.viewer.streamClosed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the Viewer's stream never learned its reader was gone")), 2_000)),
    ]);
    expect((await curl(entry.localPort, "/api/files")).status).toBe(200);
  } finally {
    await entry.close();
  }
});

test.skipIf(!pinnedInterpreterBehaviour)("an Upgrade is relayed through the vouched entry carrying the release credential", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-viewer-gateway-upgrade-"));
  const token = randomBytes(16).toString("hex");
  let upstreamHead = "";
  const upstream = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      upstreamHead = chunk.toString("latin1");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), Buffer.from(data)])));
    });
    socket.on("error", () => undefined);
  });
  const upstreamPort = await listen(upstream);
  await fs.writeFile(path.join(stateDir, "viewer-release.json"), JSON.stringify({
    revision: "abc123", image: "viewer:test", container: "llv-deploy-upgrade-test", endpoint: `http://127.0.0.1:${upstreamPort}`,
  }));
  await fs.writeFile(path.join(stateDir, "viewer-gateway.json"), JSON.stringify({ localEntry: "trusted" }));
  const local = serveViewerLocalEntry(path.join(stateDir, "viewer-release.json"), 0, "127.0.0.1", {
    gatewayFile: path.join(stateDir, "viewer-gateway.json"),
    releaseCredential: () => token,
  });
  await once(local, "listening");
  const address = local.address();
  if (!address || typeof address === "string") throw new Error("local entry did not bind a TCP port");
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection({ host: "127.0.0.1", port: address.port }, () => {
        client.write(`GET /live HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: Upgrade\r\nUpgrade: echo\r\nAuthorization: Bearer stale\r\n\r\n`);
      });
      let received = "";
      client.on("data", (chunk) => {
        received += chunk;
        if (received.includes("\r\n\r\n") && !received.includes("echo:")) client.write("ping");
        if (received.includes("echo:ping")) { client.destroy(); resolve(received); }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error(`no echo through the upgraded connection; received ${JSON.stringify(received)}`)), 3_000);
    });
    expect(echoed).toStartWith("HTTP/1.1 101 Switching Protocols");
    expect(upstreamHead).toMatch(/^GET \/live HTTP\/1\.1\r\n/);
    expect(upstreamHead).toMatch(/\r\nUpgrade: echo\r\n/i);
    expect(upstreamHead).toMatch(/\r\nConnection: Upgrade\r\n/i);
    expect(upstreamHead).toContain(`Authorization: Bearer ${token}`);
    expect(upstreamHead).not.toContain("Bearer stale");
  } finally {
    await close(local);
    await close(upstream);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("without a release target the local entry answers 503 and stays up", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llv-viewer-gateway-notarget-"));
  await fs.writeFile(path.join(stateDir, "viewer-gateway.json"), JSON.stringify({ localEntry: "trusted" }));
  const local = serveViewerLocalEntry(path.join(stateDir, "viewer-release.json"), 0, "127.0.0.1", {
    gatewayFile: path.join(stateDir, "viewer-gateway.json"),
    releaseCredential: () => "unused",
  });
  await once(local, "listening");
  const address = local.address();
  if (!address || typeof address === "string") throw new Error("local entry did not bind a TCP port");
  try {
    expect((await curl(address.port, "/")).status).toBe(503);
    expect((await curl(address.port, "/api/files")).status).toBe(503);
  } finally {
    await close(local);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});


test("serving rejection probe remains unauthenticated through the trusted gateway", async () => {
  const entry = await gateway();
  try {
    const endpoint = `http://127.0.0.1:${entry.localPort}`;
    const plan = viewerHealthRequestPlan(endpoint, entry.token);
    const authorized = await fetch(plan.root.url, { headers: plan.root.headers });
    const rejected = await fetch(plan.unauthorized!.url, { headers: plan.unauthorized!.headers });
    expect(authorized.status).toBe(200);
    expect(rejected.status).toBe(403);
  } finally { await entry.close(); }
});
