/**
 * Live MVP probe for Codex realtime V3 voice (issue #621).
 *
 * Proves, against the installed `codex` binary and the real ChatGPT-subscription
 * backend, that:
 *  (a) `thread/realtime/start` yields an SDP answer and a call id without a 404,
 *  (b) `thread/realtime/started` arrives,
 *  (c) the hosted thread the session started on carries the viewer MCP server
 *      configuration — the probe attaches the real viewer MCP server through the
 *      same `headlessCodexThreadConfig` plumbing the hosted runtime uses and
 *      captures the thread-scoped `mcpServerStatus/list` tool listing.
 *
 * All output is masked: SDP payloads are reduced to size/hash/media-line
 * evidence (ICE credentials never leave the process), and bearer tokens, JWTs,
 * and account ids are redacted from every captured string.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

import { headlessCodexThreadConfig } from "../src/lib/codexHeadlessConfig";

type JsonObject = Record<string, unknown>;
type Notification = { method: string; params?: JsonObject };

const cwd = process.cwd();
const notifications: Notification[] = [];
const requestLog: { id: number; method: string }[] = [];
const pending = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();
let nextId = 1;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/** Removes credential material from any captured string. Request ids and event
    names stay readable; tokens, JWTs, account ids, and ICE secrets do not. */
function maskSecretText(value: string): string {
  return value
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[masked-jwt]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[masked]")
    .replace(/(account[-_ ]?id["':=\s]{1,4})[0-9A-Za-z-]{8,}/gi, "$1[masked]")
    .replace(/(ice-(?:ufrag|pwd):)[^\s\\]+/g, "$1[masked]")
    .replace(/(fingerprint:sha-256 )[0-9A-Fa-f:]+/g, "$1[masked]");
}

/** Replaces a raw SDP with non-sensitive evidence of its shape. */
function sdpEvidence(sdp: string): JsonObject {
  return {
    masked: true,
    bytes: new TextEncoder().encode(sdp).byteLength,
    sha256: createHash("sha256").update(sdp).digest("hex").slice(0, 16),
    mediaLines: sdp.split(/\r?\n/).filter((line) => line.startsWith("m=")),
    hasIceCredentials: /a=ice-pwd:/.test(sdp),
    hasDataChannel: /m=application/.test(sdp),
  };
}

const SECRET_KEY = /token|secret|authorization|cookie|password|credential/i;

function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return maskSecretText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  const item = object(value);
  if (!item) return value;
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
    if (key === "sdp" && typeof entry === "string") return [key, sdpEvidence(entry)];
    if (SECRET_KEY.test(key)) return [key, "[masked]"];
    return [key, maskDeep(entry)];
  }));
}

function write(child: ChildProcessWithoutNullStreams, message: JsonObject): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: JsonObject,
): Promise<unknown> {
  const id = nextId++;
  requestLog.push({ id, method });
  write(child, { jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function waitForNotification(
  method: string,
  predicate: (params: JsonObject) => boolean,
  timeoutMs = 90_000,
): Promise<JsonObject> {
  const existing = notifications.find((entry) =>
    entry.method === method && entry.params && predicate(entry.params));
  if (existing?.params) return Promise.resolve(existing.params);

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    const poll = setInterval(() => {
      const found = notifications.find((entry) =>
        entry.method === method && entry.params && predicate(entry.params));
      if (!found?.params) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(found.params);
    }, 25);
  });
}

async function createWebRtcOffer(page: Page, useMicrophone: boolean): Promise<string> {
  return page.evaluate(async (withMicrophone) => {
    const state = window as typeof window & {
      __llvPc?: RTCPeerConnection;
      __llvEvents?: string[];
      __llvDataChannel?: RTCDataChannel;
      __llvTrackCount?: number;
    };
    const pc = new RTCPeerConnection();
    state.__llvPc = pc;
    state.__llvEvents = [];
    state.__llvTrackCount = 0;
    const log = (line: string) => {
      const entry = document.createElement("div");
      entry.textContent = line;
      document.body.append(entry);
      entry.scrollIntoView();
    };
    if (withMicrophone) {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const track of media.getAudioTracks()) pc.addTrack(track, media);
      log("🎙 microphone connected — speak whenever you're ready, close this window to hang up");
    } else {
      pc.addTransceiver("audio", { direction: "sendrecv" });
    }
    pc.ontrack = (event) => {
      state.__llvTrackCount = (state.__llvTrackCount ?? 0) + 1;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      document.body.append(audio);
      void audio.play().catch(() => {});
    };
    const channel = pc.createDataChannel("oai-events");
    state.__llvDataChannel = channel;
    channel.onmessage = (event) => {
      const raw = String(event.data);
      state.__llvEvents?.push(raw);
      if (!withMicrophone) return;
      try {
        const parsed = JSON.parse(raw) as { type?: string; text?: string; transcript?: string; delta?: string;
          item?: { text?: string; transcript?: string }; turn?: { transcript?: string } };
        const text = parsed.transcript ?? parsed.text ?? parsed.delta
          ?? parsed.item?.transcript ?? parsed.item?.text ?? parsed.turn?.transcript;
        if (parsed.type && (text || parsed.type.startsWith("session."))) {
          log(`${parsed.type}${text ? `: ${text}` : ""}`);
        }
      } catch {
        /* non-JSON wire noise stays off the screen */
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState !== "complete") return;
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if (!pc.localDescription?.sdp) throw new Error("Browser did not produce an SDP offer");
    return pc.localDescription.sdp;
  }, useMicrophone);
}

async function acceptWebRtcAnswer(page: Page, sdp: string): Promise<void> {
  await page.evaluate(async (answer) => {
    const pc = (window as typeof window & { __llvPc?: RTCPeerConnection }).__llvPc;
    if (!pc) throw new Error("Missing RTCPeerConnection");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }, sdp);
}

async function browserEvidence(page: Page): Promise<JsonObject> {
  return page.evaluate(async () => {
    const state = window as typeof window & {
      __llvPc?: RTCPeerConnection;
      __llvEvents?: string[];
      __llvDataChannel?: RTCDataChannel;
      __llvTrackCount?: number;
    };
    const stats = await state.__llvPc?.getStats();
    let inboundAudioBytes = 0;
    stats?.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") {
        inboundAudioBytes += Number(report.bytesReceived ?? 0);
      }
    });
    return {
      connectionState: state.__llvPc?.connectionState ?? null,
      iceConnectionState: state.__llvPc?.iceConnectionState ?? null,
      dataChannelState: state.__llvDataChannel?.readyState ?? null,
      trackCount: state.__llvTrackCount ?? 0,
      inboundAudioBytes,
      wireEvents: state.__llvEvents ?? [],
    };
  });
}

function installedCodexVersion(binary: string): string {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Compresses wire events for the transcript: parse JSON, mask, and keep the
    first masked sample of each distinct event type in arrival order. */
function summarizeWireEvents(raw: unknown): { types: Record<string, number>; sample: unknown[] } {
  const parsed = Array.isArray(raw)
    ? raw.map((value) => {
      try {
        return JSON.parse(String(value)) as unknown;
      } catch {
        return String(value);
      }
    })
    : [];
  const types: Record<string, number> = {};
  const sample: unknown[] = [];
  const seen = new Set<string>();
  for (const event of parsed) {
    const type = object(event) && typeof object(event)?.type === "string"
      ? String(object(event)?.type)
      : "(unparsed)";
    types[type] = (types[type] ?? 0) + 1;
    if (!seen.has(type) && sample.length < 24) {
      seen.add(type);
      sample.push(maskDeep(event));
    }
  }
  return { types, sample };
}

async function main(): Promise<void> {
  /* `--interactive` opens a visible Chrome window on the real microphone and
     keeps the call live until the window closes — a hands-on voice session
     instead of the automated evidence run. */
  const interactive = process.argv.includes("--interactive");
  const binary = process.env.LLV_CODEX_BINARY ?? "codex";
  const codexVersion = installedCodexVersion(binary);
  const mcpEntry = resolve(import.meta.dir, "../bin/mcp-server.mjs");
  const stateDir = mkdtempSync(join(tmpdir(), "llv-realtime-probe-state-"));
  const bunBinary = process.execPath;
  // Registers the viewer MCP server exactly as a managed codex home does, so
  // the probe thread inherits the same MCP configuration a hosted thread gets.
  const child = spawn(binary, [
    "-c", `mcp_servers.viewer.command=${JSON.stringify(bunBinary)}`,
    "-c", `mcp_servers.viewer.args=[${JSON.stringify(mcpEntry)}]`,
    "-c", `mcp_servers.viewer.env={LLV_STATE_DIR=${JSON.stringify(stateDir)}}`,
    "app-server",
    "--enable", "realtime_conversation",
  ], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.on("error", (error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let parsed: JsonObject | null;
    try {
      parsed = object(JSON.parse(line));
    } catch {
      return;
    }
    if (!parsed) return;
    if (typeof parsed.id === "number" && ("result" in parsed || "error" in parsed)) {
      const owner = pending.get(parsed.id);
      if (!owner) return;
      pending.delete(parsed.id);
      if (parsed.error) owner.reject(new Error(JSON.stringify(parsed.error)));
      else owner.resolve(parsed.result);
      return;
    }
    if (typeof parsed.method === "string") {
      notifications.push({
        method: parsed.method,
        ...(object(parsed.params) ? { params: object(parsed.params)! } : {}),
      });
    }
  });

  const maskedStderrTail = () =>
    maskSecretText(stderr.join("")).split(/\r?\n/).filter(Boolean).slice(-25);
  const realtimeRequestIds = () =>
    requestLog.filter((entry) => entry.method.startsWith("thread/realtime/"));

  let browser: Browser | null = null;
  /* getUserMedia needs a trustworthy origin — about:blank's opaque origin has
     no navigator.mediaDevices — so the call page is served from 127.0.0.1. */
  const pageServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(
      "<!doctype html><html><body style=\"font: 14px/1.5 monospace; padding: 12px\">Connecting Codex V3 voice…</body></html>",
      { headers: { "content-type": "text/html" } },
    ),
  });
  try {
    await request(child, "initialize", {
      clientInfo: { name: "llv-v3-probe", title: "LLV V3 Probe", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    write(child, { jsonrpc: "2.0", method: "initialized" });

    const accountRead = object(await request(child, "account/read", { refreshToken: false }));
    const account = object(accountRead?.account);
    if (account?.type !== "chatgpt") {
      throw new Error("The probe requires a ChatGPT subscription login (codex login)");
    }

    const configRead = await request(child, "config/read", { cwd, includeLayers: false });
    const threadConfig = headlessCodexThreadConfig(configRead, false, ["viewer"]);
    const threadResult = object(await request(child, "thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: threadConfig,
    }));
    const thread = object(threadResult?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) throw new Error("thread/start returned no thread id");

    // MCP evidence: the thread-scoped server/tool inventory for the same thread
    // the realtime session starts on.
    const mcpStatus = object(await request(child, "mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
    }));
    const mcpServers = (Array.isArray(mcpStatus?.data) ? mcpStatus.data : [])
      .map((entry) => {
        const server = object(entry);
        const tools = object(server?.tools) ?? {};
        return {
          name: server?.name ?? null,
          authStatus: server?.authStatus ?? null,
          toolCount: Object.keys(tools).length,
          tools: Object.keys(tools).sort(),
        };
      });

    browser = await chromium.launch({
      headless: !interactive,
      executablePath: process.env.LLV_PROBE_CHROME ?? "/usr/bin/google-chrome-stable",
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // Auto-grants the microphone prompt; interactive mode keeps the real
        // capture device while the automated run substitutes the fake one.
        "--use-fake-ui-for-media-stream",
        ...(interactive ? [] : ["--use-fake-device-for-media-stream"]),
      ],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${pageServer.port}/`);
    const offer = await createWebRtcOffer(page, interactive);

    await request(child, "thread/realtime/start", {
      threadId,
      version: "v3",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: offer },
      clientManagedHandoffs: true,
      codexResponsesAsItems: true,
      includeStartupContext: true,
    });
    const remoteSdp = await Promise.race([
      waitForNotification(
        "thread/realtime/sdp",
        (params) => params.threadId === threadId && typeof params.sdp === "string",
      ),
      waitForNotification(
        "thread/realtime/error",
        (params) => params.threadId === threadId && typeof params.message === "string",
      ).then((params) => {
        throw new Error(`Realtime start failed: ${maskSecretText(String(params.message))}`);
      }),
    ]);
    await acceptWebRtcAnswer(page, String(remoteSdp.sdp));
    const started = await waitForNotification(
      "thread/realtime/started",
      (params) => params.threadId === threadId,
    );

    let browserState: JsonObject;
    if (interactive) {
      console.error(`Voice call is live (call id ${String(started.realtimeSessionId ?? threadId)}).`);
      console.error("Speak in the Chrome window; close it to hang up.");
      let lastEvidence: JsonObject = {};
      const closed = new Promise<void>((resolve) => {
        page.on("close", () => resolve());
        browser?.on("disconnected", () => resolve());
        process.once("SIGINT", () => resolve());
      });
      const sample = setInterval(() => {
        void browserEvidence(page)
          .then((evidence) => { lastEvidence = evidence; })
          .catch(() => {});
      }, 2_000);
      await closed;
      clearInterval(sample);
      browserState = lastEvidence;
    } else {
      // Liveness + MCP visibility from inside the session: ask the live agent
      // to name its tools and let transcript notifications flow back.
      await request(child, "thread/realtime/appendText", {
        threadId,
        role: "user",
        text: "Reply in text: list the names of the MCP tools you can call right now, then say HANDSHAKE-OK.",
      });
      await Bun.sleep(Number(process.env.LLV_PROBE_SETTLE_MS ?? 45_000));
      browserState = await browserEvidence(page);
    }
    const wireEvents = summarizeWireEvents(browserState.wireEvents);
    const realtimeNotifications = notifications
      .filter((entry) => entry.method.startsWith("thread/realtime/"))
      .map((entry) => maskDeep(entry));
    console.log(JSON.stringify({
      ok: true,
      codexVersion,
      threadId,
      callId: started.realtimeSessionId ?? null,
      startedVersion: started.version ?? null,
      account: { type: account.type, planType: account.planType ?? null },
      requestIds: realtimeRequestIds(),
      mcpServers,
      sdpAnswer: sdpEvidence(String(remoteSdp.sdp)),
      browser: { ...maskDeep(object(browserState) ?? {}) as JsonObject, wireEvents },
      notifications: realtimeNotifications,
      stderr: maskedStderrTail(),
    }, null, 2));
    await request(child, "thread/realtime/stop", { threadId }).catch(() => {});
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      codexVersion,
      error: maskSecretText(error instanceof Error ? error.message : String(error)),
      requestIds: realtimeRequestIds(),
      notifications: notifications
        .filter((entry) => entry.method.startsWith("thread/realtime/"))
        .map((entry) => maskDeep(entry)),
      stderr: maskedStderrTail(),
    }, null, 2));
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    pageServer.stop(true);
    child.kill("SIGTERM");
    rmSync(stateDir, { recursive: true, force: true });
  }
}

await main();
