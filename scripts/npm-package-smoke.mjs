import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cliRuntimeHostConfig } from "../bin/server-runtime.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const standaloneServer = path.join(root, "dist/standalone/server.js");
const observationMs = 60_000;
const startupTimeoutMs = 30_000;
const pipelineTimeoutMs = 30_000;
const outputLimitBytes = 2 * 1024 * 1024;
const smokeVerdict = "Packed pipeline stage completed.\n\n```json\n{\"status\":\"pass\",\"findings\":[],\"confidence\":1}\n```";

function fakeCodexSource() {
  return `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (!process.argv.includes("app-server")) {
  process.stdout.write("[]\\n");
  process.exit(0);
}

const home = process.env.CODEX_HOME || process.env.HOME || process.cwd();
const threadId = randomUUID();
const transcript = path.join(home, "sessions", "smoke", threadId + ".jsonl");
let cwd = process.cwd();
let buffer = "";
const verdict = ${JSON.stringify(smokeVerdict)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (message, result) => send({ jsonrpc: "2.0", id: message.id, result });
const append = (payload) => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...payload }) + "\\n");

function startThread(message) {
  cwd = typeof message.params?.cwd === "string" ? message.params.cwd : cwd;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  reply(message, { thread: { id: threadId, path: transcript, turns: [], status: { type: "idle", activeFlags: [] } } });
}

function startTurn(message) {
  const turnId = "smoke-turn-" + Date.now();
  const input = Array.isArray(message.params?.input) ? message.params.input : [];
  const text = input.map((part) => typeof part?.text === "string" ? part.text : "").join("");
  const clientId = typeof message.params?.clientUserMessageId === "string" ? message.params.clientUserMessageId : "smoke-client";
  const userItem = { id: "smoke-user", type: "userMessage", clientId, text };
  const assistantItem = { id: "smoke-assistant", type: "agentMessage", text: verdict };
  reply(message, { turn: { id: turnId, status: "inProgress" } });
  setTimeout(() => {
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: userItem } });
  }, 10);
  setTimeout(() => {
    fs.writeFileSync(transcript, [
      JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: threadId, cwd } }),
      JSON.stringify({ timestamp: new Date().toISOString(), type: "turn_context", payload: { cwd } }),
    ].join("\\n") + "\\n");
    append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    append({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: verdict }] } });
    append({ type: "event_msg", payload: { type: "task_complete", last_agent_message: verdict } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: assistantItem } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [userItem, assistantItem] } } });
    send({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId, status: { type: "idle", activeFlags: [] } } });
  }, 1_500);
}

function handle(message) {
  if (!message || typeof message !== "object" || message.id === undefined) return;
  switch (message.method) {
    case "initialize": reply(message, { appServerVersion: "package-smoke" }); break;
    case "account/read": reply(message, { account: { type: "chatgpt", planType: "test" }, requiresOpenaiAuth: false }); break;
    case "account/rateLimits/read": reply(message, { rateLimits: { primary: null, secondary: null, planType: "test" } }); break;
    case "model/list": reply(message, { data: [{ id: "gpt-5.6-sol", isDefault: true, inputModalities: ["text"] }] }); break;
    case "config/read": reply(message, { config: { mcp_servers: {} } }); break;
    case "thread/start": startThread(message); break;
    case "thread/read": reply(message, { thread: { id: threadId, path: transcript, turns: [], status: { type: "idle", activeFlags: [] } } }); break;
    case "turn/start": startTurn(message); break;
    case "turn/interrupt": reply(message, {}); break;
    default: reply(message, {}); break;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
process.stdin.resume();
`;
}

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`;
      if (Buffer.byteLength(output) > outputLimitBytes) {
        output = Buffer.from(output).subarray(-outputLimitBytes).toString("utf8");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} stopped with ${signal ?? code ?? "unknown"}${output.trim() ? `: ${output.trim()}` : ""}`));
    });
  });
}

function pathWithoutBunContainer(environmentPath = "") {
  return environmentPath.split(path.delimiter)
    .filter(Boolean)
    .filter((directory) => !existsSync(path.join(directory, "bun-container")))
    .join(path.delimiter);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("smoke probe could not reserve a port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function probe(port, pathname) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, timeout: 5_000 }, (response) => {
      response.resume();
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
      }));
    });
    request.once("timeout", () => {
      request.destroy();
      resolve({ status: 0, headers: {} });
    });
    request.once("error", () => resolve({ status: 0, headers: {} }));
  });
}

function socketReady(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

function jsonRequest(port, pathname, method = "GET", body = undefined) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      timeout: 5_000,
      headers: {
        origin: `http://127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.byteLength) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        } catch {
          reject(new Error(`${method} ${pathname} returned invalid JSON: ${text.slice(0, 500)}`));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.once("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function waitForRuntimeHostPid(socketPath, child, output, previousPid = null) {
  const deadline = Date.now() + startupTimeoutMs;
  const fencePath = `${socketPath}.lock`;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const metadata = JSON.parse(await readFile(fencePath, "utf8"));
      if (
        Number.isSafeInteger(metadata.pid)
        && metadata.pid > 1
        && metadata.pid !== previousPid
        && await socketReady(socketPath)
      ) return metadata.pid;
    } catch {
      // The fence and socket move independently during a supervised restart.
    }
    await delay(100);
  }
  throw new Error(`runtime host did not publish a new supervised generation${output() ? `: ${output()}` : ""}`);
}

async function waitForStructuredStartup(port, afterMs, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  let sawRecovery = false;
  let consecutiveReady = 0;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const response = await jsonRequest(port, "/api/runtime/snapshot");
    const ready = response.status === 200 && response.body?.structuredStartup === "ready";
    if (!ready) {
      sawRecovery = true;
      consecutiveReady = 0;
    } else if (sawRecovery || Date.now() - afterMs >= 2_000) {
      consecutiveReady += 1;
      if (consecutiveReady >= 2) return;
    }
    await delay(200);
  }
  throw new Error(`Viewer did not recover structured startup after the supervised host restart${output() ? `: ${output()}` : ""}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopCliAndVerifyHost(child, runtimeHostPid, output) {
  child.kill("SIGINT");
  await Promise.race([
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`CLI did not exit after SIGINT${output() ? `: ${output()}` : ""}`);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processAlive(runtimeHostPid)) await delay(100);
  if (processAlive(runtimeHostPid)) {
    throw new Error(`CLI left its supervised runtime host alive after SIGINT${output() ? `: ${output()}` : ""}`);
  }
}

async function runPipelineSmoke(port, repoDirectory, baseRef, child, output) {
  const created = await jsonRequest(port, "/api/pipelines", "POST", {
    task: "packed structured pipeline",
    repoDir: repoDirectory,
    baseRef,
    autoStart: false,
    stages: [{
      id: "run",
      kind: "run",
      role: { roleId: "builder" },
      engine: "codex",
      "prompt": "Return the smoke verdict.",
      next: null,
    }],
  });
  if (created.status !== 201 || typeof created.body?.pipeline?.id !== "string") {
    throw new Error(`pipeline creation failed with ${created.status}: ${JSON.stringify(created.body)}`);
  }
  const id = created.body.pipeline.id;
  const started = await jsonRequest(port, `/api/pipelines/${id}`, "PATCH", { action: "start" });
  if (started.status !== 200 || started.body?.pipeline?.state !== "provisioning") {
    throw new Error(`pipeline start failed with ${started.status}: ${JSON.stringify(started.body)}`);
  }
  const deadline = Date.now() + pipelineTimeoutMs;
  let lastPipeline = null;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await probe(port, "/api/files");
    await jsonRequest(port, "/api/pipelines/tick", "POST");
    const response = await jsonRequest(port, "/api/pipelines");
    const pipeline = response.body?.pipelines?.find((candidate) => candidate.id === id);
    lastPipeline = pipeline ?? null;
    if (pipeline?.state === "needs_decision") {
      throw new Error(`packed pipeline parked: ${pipeline.stateDetail ?? pipeline.runs?.[0]?.attempts?.at(-1)?.error ?? "unknown reason"}`);
    }
    if (pipeline?.state === "completed") {
      const attempt = pipeline.runs?.[0]?.attempts?.at(-1);
      if (attempt?.state !== "passed" || attempt?.verdict?.status !== "pass" || !attempt?.conversationId) {
        throw new Error(`packed pipeline completion lacks structured stage evidence: ${JSON.stringify(attempt)}`);
      }
      return pipeline;
    }
    await delay(200);
  }
  const summary = lastPipeline ? JSON.stringify({
    state: lastPipeline.state,
    stateDetail: lastPipeline.stateDetail,
    cursor: lastPipeline.cursor,
    attempt: lastPipeline.runs?.[0]?.attempts?.at(-1),
  }) : "pipeline missing";
  throw new Error(`packed pipeline did not complete (${summary})${output() ? `: ${output()}` : ""}`);
}

export function assertHealthyResourceDiagnostic(rawHeader) {
  if (typeof rawHeader !== "string") {
    throw new Error("resource worker diagnostic is missing");
  }
  let diagnostic;
  try {
    diagnostic = JSON.parse(rawHeader);
  } catch {
    throw new Error("resource worker diagnostic is invalid JSON");
  }
  if (
    !diagnostic
    || typeof diagnostic !== "object"
    || Array.isArray(diagnostic)
    || diagnostic.status !== "complete"
    || diagnostic.degradedReason !== undefined
    || diagnostic.failure !== undefined
  ) {
    throw new Error(`resource worker diagnostic is unhealthy: ${rawHeader}`);
  }
}

function workerFailure(output) {
  return output.split("\n").find((line) => (
    line.includes("Cannot find module")
    || line.includes("Module not found")
    || /worker(?:_|\s)(?:exited|start_failed|failed to start)/i.test(line)
    || /worker exit/i.test(line)
  ));
}

async function waitForOk(port, pathname, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  let response = { status: 0, headers: {} };
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const failure = workerFailure(output());
    if (failure) throw new Error(`worker failure before ${pathname} became ready: ${failure}`);
    response = await probe(port, pathname);
    if (response.status === 200) return response;
    await delay(250);
  }
  throw new Error(`${pathname} did not answer 200 (last status ${response.status})${output() ? `: ${output()}` : ""}`);
}

function scrubOutput(output, tempDirectory) {
  return output
    .replaceAll(tempDirectory, "<package-smoke>")
    .replaceAll(root, "<repo>")
    .trim();
}

async function stop(child) {
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  signalGroup("SIGTERM");
  await Promise.race([
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000),
  ]);
  signalGroup("SIGKILL");
}

async function main() {
  if (!existsSync(standaloneServer)) {
    console.log("SKIP npm package smoke: run node scripts/prepack.mjs first.");
    return;
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-log-viewer-package-smoke-"));
  let server;
  try {
    const packageDirectory = path.join(tempDirectory, "pack");
    const extractDirectory = path.join(tempDirectory, "extract");
    const homeDirectory = path.join(tempDirectory, "home");
    const configDirectory = path.join(tempDirectory, "config");
    const stateDirectory = path.join(tempDirectory, "state");
    const runtimeTempDirectory = path.join(tempDirectory, "runtime-tmp");
    const repoDirectory = path.join(tempDirectory, "repo");
    const fakeCodex = path.join(tempDirectory, "bin", "codex");
    await Promise.all([
      mkdir(packageDirectory),
      mkdir(extractDirectory),
      mkdir(homeDirectory, { recursive: true }),
      mkdir(configDirectory),
      mkdir(stateDirectory),
      mkdir(runtimeTempDirectory),
      mkdir(repoDirectory),
      mkdir(path.dirname(fakeCodex)),
      mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
      mkdir(path.join(homeDirectory, ".claude"), { recursive: true }),
    ]);

    const packOutput = await command("npm", [
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      packageDirectory,
      "--silent",
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: homeDirectory,
        npm_config_cache: path.join(tempDirectory, "npm-cache"),
      },
    });
    console.log("npm package smoke: packed current standalone output.");
    const tarballs = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`npm pack produced ${tarballs.length} tarballs: ${packOutput}`);
    await command("tar", ["-xzf", path.join(packageDirectory, tarballs[0]), "-C", extractDirectory]);

    const extractedPackage = path.join(extractDirectory, "package");
    if (existsSync(path.join(extractedPackage, "src"))) throw new Error("packed package unexpectedly contains src/");
    const runtimePath = pathWithoutBunContainer(process.env.PATH);
    if (!runtimePath) throw new Error("smoke PATH is empty after removing bun-container");
    const bunRuntime = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    const nodeRuntime = process.env.LLV_NODE_EXECUTABLE || "node";
    await writeFile(fakeCodex, fakeCodexSource());
    await chmod(fakeCodex, 0o700);
    await command("git", ["init", "-b", "main"], { cwd: repoDirectory, env: { PATH: runtimePath, HOME: homeDirectory } });
    await command("git", [
      "-c", "user.name=Package Smoke",
      "-c", "user.email=noreply",
      "commit", "--allow-empty", "-m", "package smoke baseline",
    ], { cwd: repoDirectory, env: { PATH: runtimePath, HOME: homeDirectory } });
    const baseRef = await command("git", ["rev-parse", "HEAD"], { cwd: repoDirectory, env: { PATH: runtimePath, HOME: homeDirectory } });
    const port = await availablePort();
    const runtimeEnvironment = {
      PATH: runtimePath,
      HOME: homeDirectory,
      XDG_CONFIG_HOME: configDirectory,
      LLV_STATE_DIR: stateDirectory,
      LLV_BUN_EXECUTABLE: bunRuntime,
      LLV_CODEX_BINARY: fakeCodex,
      LLV_CODEX_HOME: path.join(homeDirectory, ".codex"),
      LLV_CLAUDE_HOME: path.join(homeDirectory, ".claude"),
      TMPDIR: runtimeTempDirectory,
      NODE_ENV: "production",
      LLV_WAKATIME_ENABLED: "1",
    };
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`;
      if (Buffer.byteLength(output) > outputLimitBytes) {
        output = Buffer.from(output).subarray(-outputLimitBytes).toString("utf8");
      }
    };
    server = spawn(nodeRuntime, ["dist/standalone/server.js"], {
      cwd: extractedPackage,
      detached: true,
      env: {
        ...runtimeEnvironment,
        HOSTNAME: "127.0.0.1",
        LLV_STRUCTURED_HOSTS: "off",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", collect);

    const safeOutput = () => scrubOutput(output, tempDirectory);
    await waitForOk(port, "/api/files", server, safeOutput);
    console.log("npm package smoke: /api/files returned 200.");
    const resourceResponse = await waitForOk(port, "/api/resources", server, safeOutput);
    assertHealthyResourceDiagnostic(resourceResponse.headers["x-llv-resource-phases"]);
    console.log("npm package smoke: /api/resources returned a healthy worker diagnostic; observing worker health.");
    const observationDeadline = Date.now() + observationMs;
    while (Date.now() < observationDeadline) {
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`standalone server exited during smoke observation: ${safeOutput()}`);
      }
      const failure = workerFailure(safeOutput());
      if (failure) throw new Error(`worker failure during smoke observation: ${failure}`);
      await delay(250);
    }
    await stop(server);
    server = undefined;

    output = "";
    const cliPort = await availablePort();
    server = spawn(bunRuntime, [
      "--bun",
      "bin/cli.mjs",
      "--no-open",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(cliPort),
    ], {
      cwd: extractedPackage,
      detached: true,
      env: runtimeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", collect);
    await waitForOk(cliPort, "/api/files", server, safeOutput);
    const cliFailure = workerFailure(safeOutput());
    if (cliFailure) throw new Error(`worker failure during CLI smoke: ${cliFailure}`);
    const socketPath = cliRuntimeHostConfig(extractedPackage, {
      env: runtimeEnvironment,
      home: homeDirectory,
    }).socketPath;
    const firstRuntimeHostPid = await waitForRuntimeHostPid(socketPath, server, safeOutput);
    if (firstRuntimeHostPid === process.pid || firstRuntimeHostPid === server.pid) {
      throw new Error("runtime host fence points at the smoke runner or Viewer process");
    }
    const restartRequestedAt = Date.now();
    process.kill(firstRuntimeHostPid, "SIGTERM");
    const restartedRuntimeHostPid = await waitForRuntimeHostPid(socketPath, server, safeOutput, firstRuntimeHostPid);
    if (restartedRuntimeHostPid === firstRuntimeHostPid) throw new Error("runtime host supervisor reused a dead process id");
    await waitForStructuredStartup(cliPort, restartRequestedAt, server, safeOutput);
    console.log("npm package smoke: CLI runtime host restarted with a new supervised generation.");
    await runPipelineSmoke(cliPort, repoDirectory, baseRef, server, safeOutput);
    await stopCliAndVerifyHost(server, restartedRuntimeHostPid, safeOutput);
    console.log("npm package smoke passed: direct and CLI launches stayed healthy; the packed structured pipeline completed; Ctrl-C stopped its host.");
  } finally {
    if (server) await stop(server);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
