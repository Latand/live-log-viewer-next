import { readTelegramSession, TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";

/**
 * Adds the local Telegram connector capability only to a host whose durable
 * MCP grant includes `telegram`. The value always comes from the owner-only
 * session store; caller-provided environment cannot forge or retain it.
 * Missing or unsafe local state leaves the capability unset so an otherwise
 * valid operator-root launch still starts before enrollment and after logout.
 */
export function withTelegramConnectorGrant(
  environment: NodeJS.ProcessEnv,
  mcpServers: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const bounded = { ...environment };
  delete bounded[TELEGRAM_CONNECTOR_TOKEN_ENV];
  if (!mcpServers?.includes("telegram")) return bounded;
  try {
    const token = readTelegramSession()?.connectorToken;
    if (token) bounded[TELEGRAM_CONNECTOR_TOKEN_ENV] = token;
  } catch { /* unsafe or unreadable state denies Telegram without blocking the host */ }
  return bounded;
}
