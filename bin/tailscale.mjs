import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { viewerChildProcessOptions } from "./server-runtime.mjs";

/* Dependency-free localization, mirroring bin/cli.mjs: English by default,
   Ukrainian when LLV_LANG=uk or the locale is a uk_* / uk.* variant. */
function detectLang() {
  const explicit = (process.env.LLV_LANG || "").toLowerCase();
  if (explicit === "uk" || explicit === "en") return explicit;
  const loc = (process.env.LC_ALL || process.env.LANG || "").toLowerCase();
  return loc === "uk" || loc.startsWith("uk_") || loc.startsWith("uk.") ? "uk" : "en";
}

const LANG = detectLang();

const MESSAGES = {
  en: {
    operatorHint:
      "Tailscale needs operator rights. Run this once in your terminal:\nsudo tailscale set --operator=$USER — then restart.",
    installMacApp: "  1. Install the app:          brew install --cask tailscale-app   (or from the App Store)",
    installMacOpen: "  2. Open Tailscale from Applications and sign in to your account.",
    installPacman: "  1. Install:                  sudo pacman -S tailscale",
    installScript: "  1. Install:                  curl -fsSL https://tailscale.com/install.sh | sh",
    installDownload: "  1. Install:                  https://tailscale.com/download",
    installService: "  2. Start the service:        sudo systemctl enable --now tailscaled",
    installLogin: "  3. Sign in to your account:  sudo tailscale up   (opens a browser to sign in)",
    installOperator: "  4. Allow serve without sudo: sudo tailscale set --operator=$USER",
    installHeader: "Tailscale not found. This is a one-time ~2-minute setup:",
    installThenRepeat: "Then run this same command again — the viewer will come up with a QR for your phone.",
    installPhone: "On the phone: install the Tailscale app and sign in with the same account.",
    installTailnetOnly: "Only your devices in the tailnet get access — nothing is exposed outside.",
    statusExited: (code) => `tailscale status exited with code ${code}`,
    statusUnreadable: "Couldn't read the Tailscale status. Check `tailscale status --json`.",
    needsLogin: [
      "Tailscale is installed but not running or needs a sign-in:",
      "",
      "  sudo tailscale up   (opens a browser to sign in)",
      "",
      "After signing in, run this same command again.",
    ],
    noDnsName:
      "Tailscale returned no DNSName. Enable MagicDNS and HTTPS certificates in the tailnet admin console and try again.",
    serveStartFail: (detail) => `Couldn't start tailscale serve: ${detail}`,
    serveStopped: "Warning: tailscale serve stopped, the local server keeps running.",
    serveFailed:
      "Couldn't start tailscale serve (the port may already be served by another rule). Check `tailscale serve status`. The local server keeps running.",
    tokenWriteFail: (path, detail, dir) =>
      `Couldn't write the access key to ${path} (${detail}). Check the permissions on directory ${dir} and try again.`,
  },
  uk: {
    operatorHint:
      "Tailscale вимагає прав оператора. Виконайте один раз у своєму терміналі:\nsudo tailscale set --operator=$USER — і перезапустіть.",
    installMacApp: "  1. Встановіть застосунок:   brew install --cask tailscale-app   (або з App Store)",
    installMacOpen: "  2. Відкрийте Tailscale з Applications і увійдіть у свій акаунт.",
    installPacman: "  1. Встановіть:               sudo pacman -S tailscale",
    installScript: "  1. Встановіть:               curl -fsSL https://tailscale.com/install.sh | sh",
    installDownload: "  1. Встановіть:               https://tailscale.com/download",
    installService: "  2. Запустіть службу:         sudo systemctl enable --now tailscaled",
    installLogin: "  3. Увійдіть у акаунт:        sudo tailscale up   (відкриє браузер для входу)",
    installOperator: "  4. Дозвольте serve без sudo: sudo tailscale set --operator=$USER",
    installHeader: "Tailscale не знайдено. Це разове налаштування на ~2 хвилини:",
    installThenRepeat: "Потім повторіть цю саму команду — viewer підніметься з QR для телефона.",
    installPhone: "На телефоні: встановіть застосунок Tailscale і увійдіть тим самим акаунтом.",
    installTailnetOnly: "Доступ матимуть лише ваші пристрої в tailnet — назовні нічого не відкривається.",
    statusExited: (code) => `tailscale status завершився з кодом ${code}`,
    statusUnreadable: "Не вдалося прочитати статус Tailscale. Перевірте `tailscale status --json`.",
    needsLogin: [
      "Tailscale встановлено, але не запущено або потрібен вхід:",
      "",
      "  sudo tailscale up   (відкриє браузер для входу)",
      "",
      "Після входу повторіть цю саму команду.",
    ],
    noDnsName:
      "Tailscale не повернув DNSName. Увімкніть MagicDNS та HTTPS certificates у tailnet admin console і повторіть.",
    serveStartFail: (detail) => `Не вдалося запустити tailscale serve: ${detail}`,
    serveStopped: "Попередження: tailscale serve зупинився, локальний сервер продовжує працювати.",
    serveFailed:
      "Не вдалося запустити tailscale serve (можливо, порт уже обслуговується іншим правилом). Перевірте `tailscale serve status`. Локальний сервер продовжує працювати.",
    tokenWriteFail: (path, detail, dir) =>
      `Не вдалося записати ключ доступу у ${path} (${detail}). Перевірте права на директорію ${dir} і повторіть.`,
  },
};

const t = MESSAGES[LANG];

export const OPERATOR_HINT = t.operatorHint;

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const MACOS_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export class TailscaleError extends Error {}

async function hasCommand(name) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    if (await isExecutable(join(entry, name))) return true;
  }
  return false;
}

/**
 * One-time setup walkthrough shown when the tailscale binary is missing:
 * exact copy-pasteable commands for this machine's package manager instead
 * of a bare download link.
 */
export async function buildInstallHint() {
  const steps = [];
  if (process.platform === "darwin") {
    steps.push(t.installMacApp, t.installMacOpen);
  } else {
    if (await hasCommand("pacman")) {
      steps.push(t.installPacman);
    } else if (await hasCommand("apt-get")) {
      steps.push(t.installScript);
    } else if (await hasCommand("dnf")) {
      steps.push(t.installScript);
    } else {
      steps.push(t.installDownload);
    }
    steps.push(t.installService, t.installLogin, t.installOperator);
  }

  return [
    t.installHeader,
    "",
    ...steps,
    "",
    t.installThenRepeat,
    t.installPhone,
    t.installTailnetOnly,
  ].join("\n");
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectTailscale() {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, "tailscale");
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  if (existsSync(MACOS_TAILSCALE) && (await isExecutable(MACOS_TAILSCALE))) {
    return MACOS_TAILSCALE;
  }

  throw new TailscaleError(await buildInstallHint());
}

function runJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, viewerChildProcessOptions({
      stdio: ["ignore", "pipe", "pipe"],
    }));

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new TailscaleError(stderr.trim() || t.statusExited(code ?? 1)));
    });
  });
}

export async function readStatus(tailscalePath) {
  const output = await runJson(tailscalePath, ["status", "--json"]);
  let status;
  try {
    status = JSON.parse(output);
  } catch {
    throw new TailscaleError(t.statusUnreadable);
  }

  const backendState = typeof status.BackendState === "string" ? status.BackendState : "";
  if (backendState === "NeedsLogin" || backendState === "Stopped") {
    throw new TailscaleError(t.needsLogin.join("\n"));
  }

  const rawDnsName = typeof status.Self?.DNSName === "string" ? status.Self.DNSName : "";
  const dnsName = rawDnsName.replace(/\.$/, "");
  if (dnsName.length === 0) {
    throw new TailscaleError(t.noDnsName);
  }

  return { backendState, dnsName };
}

export function serve(tailscalePath, port) {
  const child = spawn(tailscalePath, ["serve", String(port)], viewerChildProcessOptions({
    stdio: ["ignore", "ignore", "pipe"],
  }));

  const state = {
    stopping: false,
    operatorHintPrinted: false,
    started: false,
  };

  const startedTimer = setTimeout(() => {
    state.started = true;
  }, 500);

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (/operator|access denied|permission/i.test(text)) {
      state.operatorHintPrinted = true;
      console.error(OPERATOR_HINT);
      return;
    }

    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    console.error(t.serveStartFail(error.message));
  });

  child.on("exit", (code) => {
    clearTimeout(startedTimer);
    if (state.stopping || state.operatorHintPrinted) {
      return;
    }

    if (state.started) {
      console.error(t.serveStopped);
      return;
    }

    if (code !== 0) {
      console.error(t.serveFailed);
    }
  });

  return { child, state };
}

function configRoot() {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function tokenPath() {
  return join(configRoot(), "agent-log-viewer", "token");
}

function generateToken() {
  return randomBytes(16).toString("hex");
}

async function writeToken(path, token) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function getToken({ rotate = false } = {}) {
  const path = tokenPath();

  if (!rotate) {
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (TOKEN_PATTERN.test(existing)) {
        await chmod(path, 0o600);
        return { token: existing, path };
      }
    } catch {
      // Regenerate unreadable or missing token files.
    }
  }

  const token = generateToken();
  try {
    await writeToken(path, token);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TailscaleError(t.tokenWriteFail(path, detail, dirname(path)));
  }
  return { token, path };
}
