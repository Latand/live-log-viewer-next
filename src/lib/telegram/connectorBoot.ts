import { readTelegramConnection, readTelegramSession } from "./sessionStore";
import { readTelegramReports } from "./reportStore";

/**
 * Bringing the shared connector back after a viewer restart (issue #1133).
 *
 * THE CONNECTOR IS A CHILD OF THE VIEWER CONTAINER'S ENTRYPOINT. Restarting
 * the container kills it, and nothing in the Viewer used to notice: the
 * supervisor (`connector.ts`) starts a connector only when some consumer asks
 * for one, so the process stayed dead until a health poll or — the case this
 * exists for — a Daily Report run tripped over its absence and failed the day's
 * report. Viewer restarts are ordinary here, which is how the same failure
 * arrived on four consecutive report runs.
 *
 * So the release that owns traffic re-provisions it on boot, for exactly the
 * account that already has one: a stored credential AND reports switched on.
 * Nothing else is provisioned proactively — an operator who has not connected
 * Telegram, or who has switched the reports off, gets no process they did not
 * ask for.
 *
 * The provisioning runs through the connection service's ORDINARY health
 * check. That path already owns the connector lifecycle, already holds the
 * lease that keeps a report's sequential reads on one stable connector
 * (#1154), and already yields to a report that is mid-pass — so this adds no
 * second lifecycle owner and no concurrent reader (#1087). It is fire-and-
 * forget at the call site: a connector that takes half a minute to verify must
 * not hold the release-ready marker behind it.
 *
 * Nothing here logs a value. The upstream failures it catches carry account
 * names and connector tokens in their messages, so the host log gets a code
 * from the closed vocabulary below and nothing else.
 */

export type TelegramConnectorBootOutcome =
  /** No stored credential: there is no account to provision a connector for. */
  | "no_session"
  /** Reports are switched off, so no unattended consumer needs the connector. */
  | "reports_disabled"
  /** The connector is up and the connection reads connected. */
  | "provisioned"
  /** The health check ran and the connector still is not serving. */
  | "unavailable"
  /** The health check itself could not run. */
  | "provision_failed";

export type TelegramConnectorBootLogCode = "connector_unavailable" | "provision_failed";

export interface TelegramConnectorBootPorts {
  /** Whether an owner-only Telegram credential is stored. */
  hasCredentialedSession(): boolean;
  /** Whether the unattended consumer this exists for is switched on. */
  reportsEnabled(): boolean;
  /** The ordinary health check: ensures the connector and republishes status. */
  provision(): Promise<void>;
  /** Whether the durable connection record reads connected afterwards. */
  connected(): boolean;
  log(code: TelegramConnectorBootLogCode): void;
}

export const productionTelegramConnectorBootPorts: TelegramConnectorBootPorts = {
  hasCredentialedSession: () => {
    try {
      return readTelegramSession() !== null;
    } catch {
      /* An unsafe session keeps its explicit-deletion contract; boot is not
         the place that resolves it. */
      return false;
    }
  },
  reportsEnabled: () => readTelegramReports().settings.enabled,
  provision: async () => {
    const { telegramService } = await import("./service");
    await telegramService().checkHealth();
  },
  connected: () => {
    try {
      return readTelegramConnection().status === "connected";
    } catch {
      return false;
    }
  },
  log: (code) => console.error(`[telegram connector] ${code}`),
};

export async function provisionTelegramConnectorAtStartup(
  ports: TelegramConnectorBootPorts = productionTelegramConnectorBootPorts,
): Promise<TelegramConnectorBootOutcome> {
  if (!ports.hasCredentialedSession()) return "no_session";
  if (!ports.reportsEnabled()) return "reports_disabled";
  try {
    await ports.provision();
  } catch {
    ports.log("provision_failed");
    return "provision_failed";
  }
  if (ports.connected()) return "provisioned";
  ports.log("connector_unavailable");
  return "unavailable";
}
