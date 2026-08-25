#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectTailscale, getToken, readStatus, serve as serveTailscale, TailscaleError } from "./tailscale.mjs";
import {
  cliRuntimeHostConfig,
  cliRuntimeHostEnvironment,
  discardWakatimeEnvironmentCredential,
  viewerChildProcessOptions,
  viewerServerBunRuntime,
} from "./server-runtime.mjs";

discardWakatimeEnvironmentCredential();

const DEFAULT_PORT = 8898;
const DEFAULT_HOSTNAME = "127.0.0.1";
const READINESS_TIMEOUT_MS = 15_000;
const READINESS_INTERVAL_MS = 200;
// Socket timeout for a single readiness probe. The probe hits /api/files,
// which scans every log under ~/.claude and ~/.codex; with a few hundred
// conversations that scan takes 250-600ms, well past the 200ms poll cadence.
// Reusing READINESS_INTERVAL_MS here made every probe abort before the healthy
// server could answer, so startup always "timed out" and killed its own server.
const READINESS_PROBE_TIMEOUT_MS = 5_000;
const RUNTIME_HOST_READINESS_TIMEOUT_MS = 15_000;
const RUNTIME_HOST_READINESS_INTERVAL_MS = 100;
const RUNTIME_HOST_RESTART_BASE_MS = 500;
const RUNTIME_HOST_RESTART_MAX_MS = 10_000;
const RUNTIME_HOST_STABLE_UPTIME_MS = 30_000;

const cliPath = fileURLToPath(import.meta.url);
const cliDir = dirname(cliPath);

/* Dependency-free CLI localization: English by default, Ukrainian when
   LLV_LANG=uk or the locale (LC_ALL/LANG) is a uk_* / uk.* variant. */
function detectLang() {
  const explicit = (process.env.LLV_LANG || "").toLowerCase();
  if (explicit === "uk" || explicit === "en") return explicit;
  const loc = (process.env.LC_ALL || process.env.LANG || "").toLowerCase();
  return loc === "uk" || loc.startsWith("uk_") || loc.startsWith("uk.") ? "uk" : "en";
}

const LANG = detectLang();

const MESSAGES = {
  en: {
    usage: () => `Usage: agent-log-viewer [options]

Options:
  -p, --port <n>       Port for the local server (default ${DEFAULT_PORT})
  -H, --hostname <h>   Bind address (default ${DEFAULT_HOSTNAME})
      --tailscale      Access over Tailscale
      --no-open        Don't open the browser
      --new-token      Create a new access key
      --new-operator-token  Rotate the operator spawn capability
  -v, --version        Show the version
  -h, --help           Show this help`,
    badPort: (value) => `Invalid port: ${value}`,
    flagNeedsValue: (flag) => `Option ${flag} requires a value.`,
    hostnameNeedsValue: () => "Option --hostname requires a value.",
    unknownOption: (arg) => `Unknown option: ${arg}`,
    noPackageJson: () => "Couldn't find package.json for agent-log-viewer.",
    readPackageJsonErr: (detail) => `Couldn't read package.json: ${detail}`,
    readPackageJsonErrGeneric: () => "Couldn't read package.json.",
    noServer: () => "No standalone server.js or local next found.",
    portBusy: (port) => `Port ${port} is busy. Try: bunx agent-log-viewer --port ${port + 1}`,
    serverStartFail: (detail) => `Couldn't start the server: ${detail}`,
    serverTimeout: (seconds) => `The server didn't respond within ${seconds} seconds.`,
    bannerOpened: (url) => `  Opened:    ${url}`,
    bannerReads: () => "  Reads logs from ~/.claude/projects, ~/.codex/sessions.",
    bannerStop: () => "  Ctrl+C — stop.  --tailscale — access from your phone.",
    tsLinkWarn: () => "  The link contains an access key — don't forward it to others.",
    tsCookie: () => "  After the first open the key is stored in a cookie for 30 days.",
    nonLocalWarn: () => "Warning: a non-local address exposes the viewer to the network, so access-key mode is forced on.",
    serverNotReady: () => "Server not ready.",
    runtimeHostEntryMissing: () => "The runtime host is missing from this install. Reinstall agent-log-viewer and try again.",
    runtimeHostStartFail: (detail) => `Couldn't start the structured runtime host: ${detail}`,
    runtimeHostTimeout: (socketPath) => `the runtime host did not bind ${socketPath} within ${RUNTIME_HOST_READINESS_TIMEOUT_MS / 1_000} seconds; check the socket directory permissions`,
    runtimeHostExited: (detail) => `the runtime host exited before its socket was ready${detail ? `: ${detail}` : ""}`,
    runtimeHostOwnerMismatch: (ownerPid, childPid) => `the runtime host socket is owned by pid ${ownerPid}, while this CLI spawned pid ${childPid}; stop the other agent-log-viewer instance for this installation and try again`,
    runtimeHostRestart: (delay, detail) => `[runtime host] ${detail}; restarting in ${delay}ms`,
    runtimeHostRestartFail: (detail) => `[runtime host] restart failed: ${detail}`,
  },
  uk: {
    usage: () => `Використання: agent-log-viewer [опції]

Опції:
  -p, --port <n>       Порт для локального сервера (типово ${DEFAULT_PORT})
  -H, --hostname <h>   Адреса прив'язки (типово ${DEFAULT_HOSTNAME})
      --tailscale      Доступ через Tailscale
      --no-open        Не відкривати браузер
      --new-token      Створити новий ключ доступу
      --new-operator-token  Оновити операторський ключ запуску агентів
  -v, --version        Показати версію
  -h, --help           Показати довідку`,
    badPort: (value) => `Некоректний порт: ${value}`,
    flagNeedsValue: (flag) => `Опція ${flag} потребує значення.`,
    hostnameNeedsValue: () => "Опція --hostname потребує значення.",
    unknownOption: (arg) => `Невідома опція: ${arg}`,
    noPackageJson: () => "Не вдалося знайти package.json для agent-log-viewer.",
    readPackageJsonErr: (detail) => `Не вдалося прочитати package.json: ${detail}`,
    readPackageJsonErrGeneric: () => "Не вдалося прочитати package.json.",
    noServer: () => "Не знайдено standalone server.js або локальний next.",
    portBusy: (port) => `Порт ${port} зайнятий. Спробуйте: bunx agent-log-viewer --port ${port + 1}`,
    serverStartFail: (detail) => `Не вдалося запустити сервер: ${detail}`,
    serverTimeout: (seconds) => `Сервер не відповів за ${seconds} секунд.`,
    bannerOpened: (url) => `  Відкрито:  ${url}`,
    bannerReads: () => "  Читає логи з ~/.claude/projects, ~/.codex/sessions.",
    bannerStop: () => "  Ctrl+C — зупинити.  --tailscale — доступ з телефона.",
    tsLinkWarn: () => "  Посилання містить ключ доступу — не пересилайте його стороннім.",
    tsCookie: () => "  Після першого відкриття ключ зберігається у cookie на 30 днів.",
    nonLocalWarn: () => "Увага: нелокальна адреса відкриває viewer для мережі, тому режим ключа доступу увімкнено примусово.",
    serverNotReady: () => "Сервер не готовий.",
    runtimeHostEntryMissing: () => "У цьому пакеті немає runtime host. Перевстановіть agent-log-viewer і повторіть спробу.",
    runtimeHostStartFail: (detail) => `Не вдалося запустити structured runtime host: ${detail}`,
    runtimeHostTimeout: (socketPath) => `runtime host не створив ${socketPath} за ${RUNTIME_HOST_READINESS_TIMEOUT_MS / 1_000} секунд; перевірте права каталогу сокета`,
    runtimeHostExited: (detail) => `runtime host завершився до готовності сокета${detail ? `: ${detail}` : ""}`,
    runtimeHostOwnerMismatch: (ownerPid, childPid) => `сокетом runtime host володіє процес ${ownerPid}, а цей CLI запустив процес ${childPid}; зупиніть інший agent-log-viewer для цієї інсталяції та повторіть спробу`,
    runtimeHostRestart: (delay, detail) => `[runtime host] ${detail}; повторний запуск за ${delay} мс`,
    runtimeHostRestartFail: (detail) => `[runtime host] помилка повторного запуску: ${detail}`,
  },
};

const m = MESSAGES[LANG];

function usage() {
  return m.usage();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(m.badPort(value));
  }
  return port;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    fail(m.flagNeedsValue(flag));
  }
  return value;
}

function parseArgs(args) {
  const options = {
    port: DEFAULT_PORT,
    hostname: DEFAULT_HOSTNAME,
    tailscale: false,
    noOpen: false,
    newToken: false,
    newOperatorToken: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-p" || arg === "--port") {
      const value = requireValue(args, index, arg);
      options.port = parsePort(value);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "-H" || arg === "--hostname") {
      options.hostname = requireValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--hostname=")) {
      const value = arg.slice("--hostname=".length);
      if (!value) {
        fail(m.hostnameNeedsValue());
      }
      options.hostname = value;
    } else if (arg === "--tailscale") {
      options.tailscale = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--new-token") {
      options.newToken = true;
    } else if (arg === "--new-operator-token") {
      options.newOperatorToken = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      fail(m.unknownOption(arg));
    }
  }

  return options;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function findPackageRoot(startDir) {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      fail(m.noPackageJson());
    }
    currentDir = parentDir;
  }
}

function readPackageJson(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    fail(
      error instanceof Error
        ? m.readPackageJsonErr(error.message)
        : m.readPackageJsonErrGeneric(),
    );
  }
}

function resolveServer(packageRoot) {
  const bunRuntime = viewerServerBunRuntime();
  const commandFor = (command, args, bunEntry = command, bunArgs = args) => bunRuntime
    ? { command: bunRuntime, args: ["--bun", bunEntry, ...bunArgs] }
    : { command, args };
  const publishedStandalone = join(packageRoot, "dist", "standalone", "server.js");
  if (existsSync(publishedStandalone)) {
    const launch = commandFor(process.execPath, [publishedStandalone], publishedStandalone, []);
    return {
      ...launch,
      cwd: join(packageRoot, "dist", "standalone"),
      label: "server.js",
    };
  }

  const repoStandalone = join(packageRoot, ".next", "standalone", "server.js");
  if (existsSync(repoStandalone)) {
    const launch = commandFor(process.execPath, [repoStandalone], repoStandalone, []);
    return {
      ...launch,
      cwd: join(packageRoot, ".next", "standalone"),
      label: "server.js",
    };
  }

  const nextBin = join(packageRoot, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    fail(m.noServer());
  }

  return {
    ...commandFor(nextBin, ["start"]),
    cwd: packageRoot,
    label: "next start",
  };
}

function buildChildEnv(options, runtime, packageRoot, runtimeHostEnvironment) {
  const env = {
    ...runtimeHostEnvironment,
    PORT: String(options.port),
    // zsh exports HOSTNAME with the machine name on this user's machine; setting it here keeps standalone bound to the requested address.
    HOSTNAME: options.hostname,
  };

  // The standalone server runs with cwd inside dist/standalone, so the
  // Telegram connector assets (issue #1059) are pinned to the package root
  // explicitly; a pre-set override always wins.
  const telegramVendor = join(packageRoot, "vendor", "telegram-mcp");
  if (!env.LLV_TELEGRAM_VENDOR_DIR && existsSync(telegramVendor)) {
    env.LLV_TELEGRAM_VENDOR_DIR = telegramVendor;
  }
  const telegramBridge = join(packageRoot, "bin", "telegram-login-bridge.py");
  if (!env.LLV_TELEGRAM_BRIDGE && existsSync(telegramBridge)) {
    env.LLV_TELEGRAM_BRIDGE = telegramBridge;
  }
  const telegramServerBridge = join(packageRoot, "bin", "telegram-mcp-server.py");
  if (!env.LLV_TELEGRAM_SERVER_BRIDGE && existsSync(telegramServerBridge)) {
    env.LLV_TELEGRAM_SERVER_BRIDGE = telegramServerBridge;
  }
  const telegramSessionReader = join(packageRoot, "bin", "telegram-session-reader.mjs");
  if (!env.LLV_TELEGRAM_SESSION_READER && existsSync(telegramSessionReader)) {
    env.LLV_TELEGRAM_SESSION_READER = telegramSessionReader;
  }
  const telegramProvisioner = join(packageRoot, "bin", "provision-telegram-connector.mjs");
  if (!env.LLV_TELEGRAM_PROVISIONER && existsSync(telegramProvisioner)) {
    env.LLV_TELEGRAM_PROVISIONER = telegramProvisioner;
  }

  if (runtime.llvToken) {
    env.LLV_TOKEN = runtime.llvToken;
  }

  if (runtime.llvTsHost) {
    env.LLV_TS_HOST = runtime.llvTsHost;
  }

  if (runtime.tailnetUrl) {
    env.LLV_TS_URL = runtime.tailnetUrl;
  }

  if (options.newOperatorToken) {
    env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY = "1";
  }

  return env;
}

function startServer(server, options, runtime, tailscaleProcessRef, runtimeHostSupervisor, packageRoot, runtimeHostEnvironment) {
  const child = spawn(server.command, server.args, viewerChildProcessOptions({
    cwd: server.cwd,
    env: buildChildEnv(options, runtime, packageRoot, runtimeHostEnvironment),
    stdio: ["ignore", "inherit", "pipe"],
  }));

  const state = {
    sawAddressInUse: false,
    stopping: false,
  };

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (text.includes("EADDRINUSE")) {
      state.sawAddressInUse = true;
      console.error(m.portBusy(options.port));
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      return;
    }

    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    state.stopping = true;
    void Promise.all([
      tailscaleProcessRef?.current ? stopChild(tailscaleProcessRef.current) : Promise.resolve(),
      runtimeHostSupervisor.stop(),
    ]).finally(() => fail(m.serverStartFail(error.message)));
  });

  child.on("exit", async (code, signal) => {
    if (state.stopping) {
      return;
    }

    // The server dying on its own (crash, EADDRINUSE) still leaves `tailscale
    // serve` running as our child; stop it through the bounded path (SIGTERM,
    // 2s, SIGKILL) so an unexpected server exit does not orphan the tailnet
    // mapping even when serve ignores SIGTERM.
    if (tailscaleProcessRef?.current) {
      await stopChild(tailscaleProcessRef.current);
    }
    await runtimeHostSupervisor.stop();

    if (state.sawAddressInUse) {
      process.exit(1);
    }

    if (signal) {
      process.exit(0);
    }

    process.exit(code ?? 1);
  });

  return { child, state };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function probeRuntimeHost(socketPath) {
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

function runtimeHostFenceOwner(socketPath) {
  try {
    const owner = JSON.parse(readFileSync(`${socketPath}.lock`, "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 1) return null;
    if (typeof owner.startIdentity !== "string" || !owner.startIdentity.startsWith(`${owner.pid}:`)) return null;
    if (typeof owner.acquisitionId !== "string" || owner.acquisitionId.length < 16) return null;
    return owner;
  } catch {
    return null;
  }
}

function runtimeHostExitDetail(processHandle) {
  const { child, state } = processHandle;
  if (state.spawnError) {
    return state.spawnError.code === "ENOENT"
      ? `Bun executable ${state.command} is unavailable (${state.spawnError.message})`
      : `Bun could not launch the host (${state.spawnError.message})`;
  }
  const outcome = child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode ?? "unknown"}`;
  const stderr = state.stderrTail
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  return stderr ? `${outcome}: ${stderr}` : outcome;
}

async function waitForRuntimeHost(socketPath, processHandle = null) {
  const deadline = Date.now() + RUNTIME_HOST_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processHandle?.state.spawnError) {
      throw new Error(runtimeHostExitDetail(processHandle));
    }
    if (processHandle && (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null)) {
      throw new Error(m.runtimeHostExited(runtimeHostExitDetail(processHandle)));
    }
    if (await probeRuntimeHost(socketPath)) {
      const owner = runtimeHostFenceOwner(socketPath);
      if (!processHandle) return;
      if (owner?.pid === processHandle.child.pid) return;
      if (owner) throw new Error(m.runtimeHostOwnerMismatch(owner.pid, processHandle.child.pid));
    }
    await wait(RUNTIME_HOST_READINESS_INTERVAL_MS);
  }
  throw new Error(m.runtimeHostTimeout(socketPath));
}

function createRuntimeHostSupervisor(config, bunRuntime, environment, packageRoot) {
  let current = null;
  let restartTimer = null;
  let restartFailures = 0;
  let stopping = false;

  const scheduleRestart = (detail, uptimeMs = 0) => {
    if (stopping || restartTimer) return;
    restartFailures = uptimeMs >= RUNTIME_HOST_STABLE_UPTIME_MS ? 1 : restartFailures + 1;
    const delay = Math.min(
      RUNTIME_HOST_RESTART_BASE_MS * (2 ** Math.max(0, restartFailures - 1)),
      RUNTIME_HOST_RESTART_MAX_MS,
    );
    console.error(m.runtimeHostRestart(delay, detail));
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void launch(false).catch((error) => {
        if (stopping) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(m.runtimeHostRestartFail(message));
        scheduleRestart(message);
      });
    }, delay);
  };

  const spawnHost = () => {
    const child = spawn(bunRuntime, ["--bun", config.entrypoint], viewerChildProcessOptions({
      cwd: packageRoot,
      env: environment,
      stdio: ["ignore", "inherit", "pipe"],
    }));
    const state = {
      command: bunRuntime,
      readyAt: null,
      spawnError: null,
      stderrTail: "",
      stopping: false,
    };
    const processHandle = { child, state };
    current = processHandle;
    child.stderr.on("data", (chunk) => {
      state.stderrTail = `${state.stderrTail}${chunk}`.slice(-8_192);
      process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      state.spawnError = error;
    });
    child.once("exit", () => {
      if (current !== processHandle || stopping || state.stopping || state.readyAt === null) return;
      scheduleRestart(runtimeHostExitDetail(processHandle), Date.now() - state.readyAt);
    });
    return processHandle;
  };

  const launch = async (initial) => {
    const processHandle = spawnHost();
    try {
      await waitForRuntimeHost(config.socketPath, processHandle);
      processHandle.state.readyAt = Date.now();
      if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
        throw new Error(m.runtimeHostExited(runtimeHostExitDetail(processHandle)));
      }
    } catch (error) {
      await stopChild(processHandle);
      if (initial) throw error;
      throw error;
    }
  };

  return {
    async start() {
      if (!existsSync(config.entrypoint)) throw new Error(m.runtimeHostEntryMissing());
      await launch(true);
    },
    async stop() {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (current) await stopChild(current);
    },
  };
}

function probe(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("error", () => {
      resolve(false);
    });

    request.setTimeout(READINESS_PROBE_TIMEOUT_MS, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function portAlreadyResponds(port) {
  return probe(`http://127.0.0.1:${port}/api/files`);
}

async function waitForReadiness(port) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  const url = `http://127.0.0.1:${port}/api/files`;

  while (Date.now() < deadline) {
    if (await probe(url)) {
      return;
    }

    await wait(READINESS_INTERVAL_MS);
  }

  throw new Error(m.serverTimeout(READINESS_TIMEOUT_MS / 1000));
}

function localUrl(options) {
  const host = options.hostname === "::1" ? "[::1]" : options.hostname;
  return `http://${host}:${options.port}/`;
}

function printBanner(version, options) {
  console.log(`  ✳ Agent Log Viewer v${version}`);
  console.log(m.bannerOpened(localUrl(options)));
  console.log(m.bannerReads());
  console.log(m.bannerStop());
}

async function printTailscaleBanner(runtime) {
  if (!runtime.tailnetUrl) {
    return;
  }

  console.log(`  Tailnet:   ${runtime.tailnetUrl}`);
  const qrcodeModule = await import("qrcode-terminal");
  const qrcode = qrcodeModule.default ?? qrcodeModule;
  await new Promise((resolve) => {
    qrcode.generate(runtime.tailnetUrl, { small: true }, (qr) => {
      console.log(qr);
      resolve();
    });
  });
  console.log(m.tsLinkWarn());
  console.log(m.tsCookie());
}

function openBrowser(url) {
  const opener =
    process.platform === "linux" ? "xdg-open" : process.platform === "darwin" ? "open" : null;

  if (!opener) {
    return;
  }

  const child = spawn(opener, [url], viewerChildProcessOptions({
    stdio: "ignore",
    detached: true,
  }));
  child.unref();
}

async function stopChild(processHandle) {
  const { child, state } = processHandle;
  state.stopping = true;

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
}

async function stopAll(serverProcess, tailscaleProcess, runtimeHostSupervisor) {
  await Promise.all([
    serverProcess ? stopChild(serverProcess) : Promise.resolve(),
    tailscaleProcess ? stopChild(tailscaleProcess) : Promise.resolve(),
    runtimeHostSupervisor ? runtimeHostSupervisor.stop() : Promise.resolve(),
  ]);
}

function installSignalHandlers(serverProcess, tailscaleProcessRef, runtimeHostSupervisor) {
  const shutdown = async () => {
    await stopAll(serverProcess, tailscaleProcessRef.current, runtimeHostSupervisor);
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function prepareRuntime(options) {
  const runtime = {
    llvToken: undefined,
    llvTsHost: undefined,
    tailnetUrl: undefined,
    tailscalePath: undefined,
  };

  const nonLoopbackBind = !isLoopbackHostname(options.hostname);
  if (nonLoopbackBind) {
    console.error(m.nonLocalWarn());
  }

  if (options.tailscale) {
    const tailscalePath = await detectTailscale();
    const status = await readStatus(tailscalePath);
    const { token } = await getToken({ rotate: options.newToken });
    runtime.llvToken = token;
    runtime.llvTsHost = status.dnsName;
    runtime.tailnetUrl = `https://${status.dnsName}/?k=${token}`;
    runtime.tailscalePath = tailscalePath;
    options.hostname = DEFAULT_HOSTNAME;
    return runtime;
  }

  if (nonLoopbackBind) {
    const { token } = await getToken({ rotate: options.newToken });
    runtime.llvToken = token;
  }

  return runtime;
}

/* Symlink every skill this repo ships (.claude/skills/*) into each installed
   agent's global skills dir, so one `git pull` propagates the skills to Claude
   and Codex at once — no per-agent copy to keep in sync. Only runs from a real
   git checkout (the persistent source), never from a transient npm/bunx install.
   Idempotent; a pre-existing real copy is backed up once (<name>.bak) before it
   is replaced with the link. Best-effort — never blocks startup. */
function linkSkills(packageRoot) {
  if (!existsSync(join(packageRoot, ".git"))) return; // not a checkout → skip
  const source = join(packageRoot, ".claude", "skills");
  let skills;
  try {
    skills = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return;
  }
  if (skills.length === 0) return;
  const roots = [join(homedir(), ".claude", "skills"), join(homedir(), ".codex", "skills")];
  for (const root of roots) {
    if (!existsSync(dirname(root))) continue; // that agent isn't installed
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      continue;
    }
    for (const skill of skills) {
      const src = join(source, skill.name);
      const dest = join(root, skill.name);
      try {
        const stat = lstatSync(dest);
        if (stat.isSymbolicLink()) {
          try {
            if (realpathSync(dest) === realpathSync(src)) continue; // already linked here
          } catch {
            /* dangling link → relink below */
          }
          rmSync(dest);
        } else {
          /* Back up a pre-existing real copy into a hidden sibling dir so the
             skill loader (which scans visible subdirs for SKILL.md) never picks
             the backup up as a duplicate skill. */
          const backupDir = join(root, ".skill-backups");
          const backup = join(backupDir, skill.name);
          try {
            mkdirSync(backupDir, { recursive: true });
          } catch {
            /* fall through */
          }
          if (existsSync(backup)) rmSync(dest, { recursive: true, force: true });
          else renameSync(dest, backup);
        }
      } catch {
        /* dest is absent — fall through and create the link */
      }
      try {
        symlinkSync(src, dest, "dir");
      } catch {
        /* non-fatal: a single skill failing to link must not break launch */
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = findPackageRoot(cliDir);
  try {
    linkSkills(packageRoot);
  } catch {
    /* skill linking is best-effort — never block the viewer from starting */
  }
  const packageJson = readPackageJson(packageRoot);
  const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.version) {
    console.log(version);
    return;
  }

  let runtime;
  try {
    runtime = await prepareRuntime(options);
  } catch (error) {
    if (error instanceof TailscaleError) {
      fail(error.message);
    }
    throw error;
  }

  if (await portAlreadyResponds(options.port)) {
    console.error(m.portBusy(options.port));
    process.exit(1);
  }

  const server = resolveServer(packageRoot);
  const runtimeHostConfig = cliRuntimeHostConfig(packageRoot);
  const runtimeHostEnvironment = cliRuntimeHostEnvironment(process.env, runtimeHostConfig);
  const runtimeHostSupervisor = createRuntimeHostSupervisor(
    runtimeHostConfig,
    viewerServerBunRuntime(),
    runtimeHostEnvironment,
    packageRoot,
  );
  try {
    await runtimeHostSupervisor.start();
  } catch (error) {
    await runtimeHostSupervisor.stop();
    fail(m.runtimeHostStartFail(error instanceof Error ? error.message : String(error)));
  }

  const tailscaleProcessRef = { current: null };
  const serverProcess = startServer(
    server,
    options,
    runtime,
    tailscaleProcessRef,
    runtimeHostSupervisor,
    packageRoot,
    runtimeHostEnvironment,
  );
  installSignalHandlers(serverProcess, tailscaleProcessRef, runtimeHostSupervisor);

  if (options.tailscale && runtime.tailscalePath) {
    tailscaleProcessRef.current = serveTailscale(runtime.tailscalePath, options.port);
  }

  try {
    await waitForReadiness(options.port);
  } catch (error) {
    await stopAll(serverProcess, tailscaleProcessRef.current, runtimeHostSupervisor);
    fail(error instanceof Error ? error.message : m.serverNotReady());
  }

  if (
    serverProcess.state.sawAddressInUse ||
    serverProcess.child.exitCode !== null ||
    serverProcess.child.signalCode !== null
  ) {
    process.exit(serverProcess.state.sawAddressInUse ? 1 : (serverProcess.child.exitCode ?? 1));
  }

  printBanner(version, options);
  if (options.tailscale) {
    await printTailscaleBanner(runtime);
  }

  if (!options.noOpen && process.stdout.isTTY) {
    openBrowser(localUrl(options));
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
