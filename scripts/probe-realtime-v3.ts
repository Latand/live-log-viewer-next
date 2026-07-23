import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

type JsonObject = Record<string, unknown>;
type Notification = { method: string; params?: JsonObject };

const cwd = process.cwd();
const notifications: Notification[] = [];
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

function write(child: ChildProcessWithoutNullStreams, message: JsonObject): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(
  child: ChildProcessWithoutNullStreams,
  method: string,
  params: JsonObject,
): Promise<unknown> {
  const id = nextId++;
  write(child, { jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function waitForNotification(
  method: string,
  predicate: (params: JsonObject) => boolean,
  timeoutMs = 60_000,
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

async function createWebRtcOffer(page: Page): Promise<string> {
  return page.evaluate(async () => {
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
    pc.addTransceiver("audio", { direction: "sendrecv" });
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
    channel.onmessage = (event) => state.__llvEvents?.push(String(event.data));
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
  });
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
      dataChannelState: state.__llvDataChannel?.readyState ?? null,
      trackCount: state.__llvTrackCount ?? 0,
      inboundAudioBytes,
      wireEvents: state.__llvEvents ?? [],
    };
  });
}

async function main(): Promise<void> {
  const child = spawn("codex", ["app-server", "--enable", "realtime_conversation"], {
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
    const parsed = object(JSON.parse(line));
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

  let browser: Browser | null = null;
  try {
    await request(child, "initialize", {
      clientInfo: { name: "llv-v3-spike", title: "LLV V3 Spike", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    write(child, { jsonrpc: "2.0", method: "initialized" });
    const threadResult = object(await request(child, "thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "gpt-5.6-sol",
      ephemeral: true,
    }));
    const thread = object(threadResult?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) throw new Error("thread/start returned no thread id");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    });
    const page = await browser.newPage();
    await page.goto("about:blank");
    const offer = await createWebRtcOffer(page);

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
        throw new Error(`Realtime start failed: ${String(params.message)}`);
      }),
    ]);
    await acceptWebRtcAnswer(page, String(remoteSdp.sdp));
    await waitForNotification(
      "thread/realtime/started",
      (params) => params.threadId === threadId,
    );

    await request(child, "thread/realtime/appendText", {
      threadId,
      role: "user",
      text: "Please delegate to the Codex worker: read package.json and tell me the package name. Narrate progress briefly.",
    });

    await Bun.sleep(45_000);
    const browserState = await browserEvidence(page);
    const realtimeNotifications = notifications.filter((entry) =>
      entry.method.startsWith("thread/realtime/"));
    const wireEvents = Array.isArray(browserState.wireEvents)
      ? browserState.wireEvents.map((value) => {
        try {
          return JSON.parse(String(value));
        } catch {
          return value;
        }
      })
      : [];
    console.log(JSON.stringify({
      codexVersion: "0.145.0",
      threadId,
      browser: { ...browserState, wireEvents },
      notifications: realtimeNotifications,
      stderr: stderr.join("").split(/\r?\n/).filter(Boolean).slice(-20),
    }, null, 2));
    await request(child, "thread/realtime/stop", { threadId }).catch(() => {});
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      notifications: notifications.filter((entry) =>
        entry.method.startsWith("thread/realtime/")),
      stderr: stderr.join("").split(/\r?\n/).filter(Boolean).slice(-40),
    }, null, 2));
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    child.kill("SIGTERM");
  }
}

await main();
