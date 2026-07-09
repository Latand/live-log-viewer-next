export interface DeviceAuthChallenge {
  url: string;
  code: string;
}

const DEVICE_AUTH_HOSTS = new Set(["auth.openai.com", "chatgpt.com"]);
const CODE = /(?:user\s*code|device\s*code|code)\s*[:：]?\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i;
const BARE_CODE = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/g;

/** Extracts the two safe display values from Codex device-login output. */
export function deviceAuthChallenge(screen: string): DeviceAuthChallenge | null {
  let url: string | null = null;
  for (const raw of screen.match(URL_PATTERN) ?? []) {
    try {
      const candidate = new URL(raw);
      if (DEVICE_AUTH_HOSTS.has(candidate.hostname)) {
        url = candidate.toString();
        break;
      }
    } catch {
      continue;
    }
  }
  const code = CODE.exec(screen)?.[1] ?? BARE_CODE.exec(screen)?.[1] ?? null;
  return url && code ? { url, code: code.toUpperCase() } : null;
}
