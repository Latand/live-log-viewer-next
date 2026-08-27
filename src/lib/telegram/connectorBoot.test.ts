import { expect, test } from "bun:test";

import { provisionTelegramConnectorAtStartup, type TelegramConnectorBootPorts } from "./connectorBoot";

/** The boot world, with nothing on disk and nothing real to reach: every fact
    the decision needs is injected, and `provision` counts the one call that
    would touch the supervisor. */
function bootPorts(overrides: Partial<TelegramConnectorBootPorts> = {}): TelegramConnectorBootPorts & { provisions: number; logs: string[] } {
  const state = {
    provisions: 0,
    logs: [] as string[],
    hasCredentialedSession: () => true,
    reportsEnabled: () => true,
    provision: async () => { state.provisions += 1; },
    connected: () => true,
    log: (code: string) => { state.logs.push(code); },
    ...overrides,
  };
  return state as TelegramConnectorBootPorts & { provisions: number; logs: string[] };
}

test("a credentialed account with reports on re-provisions the connector at boot", async () => {
  /* #1133: the connector is a child of the viewer container's entrypoint, so a
     restart kills it and nothing brought it back until a consumer tripped over
     its absence — which, for the Daily Report, was the run itself. */
  const ports = bootPorts();

  await expect(provisionTelegramConnectorAtStartup(ports)).resolves.toBe("provisioned");
  expect(ports.provisions).toBe(1);
  expect(ports.logs).toEqual([]);
});

test("no stored credential provisions nothing", async () => {
  const ports = bootPorts({ hasCredentialedSession: () => false });

  await expect(provisionTelegramConnectorAtStartup(ports)).resolves.toBe("no_session");
  expect(ports.provisions).toBe(0);
});

test("reports switched off leave the connector to its consumers", async () => {
  const ports = bootPorts({ reportsEnabled: () => false });

  await expect(provisionTelegramConnectorAtStartup(ports)).resolves.toBe("reports_disabled");
  expect(ports.provisions).toBe(0);
});

test("a connector that does not come up at boot is recorded, not thrown", async () => {
  const ports = bootPorts({ connected: () => false });

  await expect(provisionTelegramConnectorAtStartup(ports)).resolves.toBe("unavailable");
  expect(ports.provisions).toBe(1);
  expect(ports.logs).toEqual(["connector_unavailable"]);
});

test("a provisioning failure is contained inside startup", async () => {
  const ports = bootPorts({
    provision: async () => { throw new Error("connector spawn failed for 'Account A' token=connector-token-value"); },
  });

  await expect(provisionTelegramConnectorAtStartup(ports)).resolves.toBe("provision_failed");
  /* A code, never the upstream message: it can carry an account name or a
     token, and this line goes to the host log. */
  expect(ports.logs).toEqual(["provision_failed"]);
});
