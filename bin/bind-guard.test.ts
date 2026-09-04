import net from "node:net";
import { expect, test } from "bun:test";

import {
  classifyBindProbeFailure,
  linkLocalScopeZone,
  newlyBoundNonLoopbackAddress,
  nonLoopbackProbeAddresses,
  readNonLoopbackBindState,
} from "./server-runtime.mjs";

/**
 * The loopback bind guard asks one question per non-loopback address: is it
 * bound after the Viewer launched, with nothing in the reading taken before the
 * launch to excuse that? Everything here drives that question through its two
 * platform-dependent halves — how an address is named, and what a failed listen
 * means — because the runner that broke it (Windows) cannot be run from this
 * checkout.
 *
 * Addresses below are invented. `fe80::1` and `fe80::2` are link-local by
 * construction and belong to no machine.
 */

function interfaceEntry(overrides: Record<string, unknown> = {}) {
  return {
    address: "fe80::1",
    family: "IPv6",
    internal: false,
    scopeid: 12,
    ...overrides,
  };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not reserve a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("a Windows link-local address is scoped by interface index, never by adapter name", () => {
  const addresses = nonLoopbackProbeAddresses({
    platform: "win32",
    interfaces: { "Ethernet 3": [interfaceEntry()] },
  });

  expect(addresses).toEqual(["fe80::1%12"]);
});

test("a POSIX link-local address keeps the interface name as its zone", () => {
  const addresses = nonLoopbackProbeAddresses({
    platform: "linux",
    interfaces: { eth0: [interfaceEntry()] },
  });

  expect(addresses).toEqual(["fe80::1%eth0"]);
});

test("a link-local address whose scope cannot be expressed is skipped, not probed unscoped", () => {
  const addresses = nonLoopbackProbeAddresses({
    platform: "win32",
    interfaces: {
      "Ethernet 3": [interfaceEntry({ scopeid: 0 })],
      "Ethernet 4": [interfaceEntry({ address: "192.0.2.10", family: "IPv4", scopeid: 0 })],
    },
  });

  expect(addresses).toEqual(["192.0.2.10"]);
});

test("internal addresses never enter the probe set", () => {
  const addresses = nonLoopbackProbeAddresses({
    platform: "linux",
    interfaces: {
      lo: [interfaceEntry({ address: "127.0.0.1", family: "IPv4", internal: true, scopeid: 0 })],
      eth0: [interfaceEntry({ address: "192.0.2.10", family: "IPv4", scopeid: 0 })],
    },
  });

  expect(addresses).toEqual(["192.0.2.10"]);
});

test("Windows answers an exclusive-use conflict with EACCES, which is occupancy", () => {
  expect(classifyBindProbeFailure({ code: "EADDRINUSE" }, "linux")).toBe("occupied");
  expect(classifyBindProbeFailure({ code: "EADDRINUSE" }, "win32")).toBe("occupied");
  expect(classifyBindProbeFailure({ code: "EACCES" }, "win32")).toBe("occupied");
  expect(classifyBindProbeFailure({ code: "EACCES" }, "linux")).toBe("unevaluated");
  expect(classifyBindProbeFailure({ code: "EINVAL" }, "win32")).toBe("unevaluated");
  expect(classifyBindProbeFailure({ code: "ENOTFOUND" }, "win32")).toBe("unevaluated");
  expect(classifyBindProbeFailure(new Error("Failed to listen at fe80::1%Ethernet 3"), "win32")).toBe("unevaluated");
});

test("linkLocalScopeZone refuses a zone it cannot express rather than inventing one", () => {
  expect(linkLocalScopeZone({ scopeid: 12 }, "Ethernet 3", "win32")).toBe("12");
  expect(linkLocalScopeZone({ scopeid: 0 }, "Ethernet 3", "win32")).toBeNull();
  expect(linkLocalScopeZone({ scopeid: 1.5 }, "Ethernet 3", "win32")).toBeNull();
  expect(linkLocalScopeZone({ scopeid: 12 }, "eth0", "linux")).toBe("eth0");
  expect(linkLocalScopeZone({ scopeid: 12 }, "", "linux")).toBeNull();
});

test("a probe that cannot answer for one address neither aborts the reading nor counts as exposure", async () => {
  const port = await availablePort();
  const unevaluable = "fe80::1%12";
  const state = await readNonLoopbackBindState(port, {
    platform: "win32",
    addresses: [unevaluable, "192.0.2.10"],
    listen: async (address: string) => {
      if (address === unevaluable) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });

  expect([...state.unevaluated.keys()]).toEqual([unevaluable]);
  expect([...state.free]).toEqual(["192.0.2.10"]);
  expect([...state.occupied]).toEqual([]);

  // Startup proceeds: the reading resolved, and the address nobody could
  // evaluate is not evidence that the Viewer widened its bind.
  const before = await readNonLoopbackBindState(port, {
    platform: "win32",
    addresses: [unevaluable],
    listen: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  expect(newlyBoundNonLoopbackAddress(before, state)).toBeNull();
});

test("every address failing the probe is still not an aborted reading", async () => {
  const port = await availablePort();
  const state = await readNonLoopbackBindState(port, {
    platform: "win32",
    addresses: ["fe80::1%12", "fe80::2%13"],
    listen: async () => {
      throw Object.assign(new Error("Failed to listen"), { code: "EINVAL" });
    },
  });

  expect(state.unevaluated.size).toBe(2);
  expect(state.free.size).toBe(0);
  expect(state.occupied.size).toBe(0);
});

test("an address that was free before launch and is bound after it still stops startup", async () => {
  const port = await availablePort();
  const address = "192.0.2.10";
  const before = await readNonLoopbackBindState(port, {
    platform: "linux",
    addresses: [address],
    listen: async () => {},
  });
  const after = await readNonLoopbackBindState(port, {
    platform: "linux",
    addresses: [address],
    listen: async () => {
      throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    },
  });

  expect([...before.free]).toEqual([address]);
  expect([...after.occupied]).toEqual([address]);
  expect(newlyBoundNonLoopbackAddress(before, after)).toBe(address);
});

test("an address occupied before launch is never attributed to the Viewer", async () => {
  const port = await availablePort();
  const address = "192.0.2.10";
  const occupied = async () => {
    throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
  };
  const before = await readNonLoopbackBindState(port, { platform: "linux", addresses: [address], listen: occupied });
  const after = await readNonLoopbackBindState(port, { platform: "linux", addresses: [address], listen: occupied });

  expect(newlyBoundNonLoopbackAddress(before, after)).toBeNull();
});

test("an address nobody could evaluate before launch is not evidence when it is occupied after", async () => {
  const port = await availablePort();
  const address = "fe80::1%12";
  const before = await readNonLoopbackBindState(port, {
    platform: "win32",
    addresses: [address],
    listen: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  const after = await readNonLoopbackBindState(port, {
    platform: "win32",
    addresses: [address],
    listen: async () => {
      throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    },
  });

  expect([...after.occupied]).toEqual([address]);
  expect(newlyBoundNonLoopbackAddress(before, after)).toBeNull();
});

test("an enumeration that cannot list any interface stays fatal", async () => {
  const port = await availablePort();
  const unreadable = new Proxy({}, {
    ownKeys() {
      throw new Error("network interfaces unavailable");
    },
  });

  expect(() => nonLoopbackProbeAddresses({ platform: "linux", interfaces: unreadable }))
    .toThrow("network interfaces unavailable");
  await expect(readNonLoopbackBindState(port, { platform: "linux", interfaces: unreadable }))
    .rejects.toThrow("network interfaces unavailable");
});

test("the live probe answers for every enumerated address without aborting", async () => {
  const port = await availablePort();
  const addresses = nonLoopbackProbeAddresses();
  const state = await readNonLoopbackBindState(port);

  // Whatever this machine's interfaces look like — including a Windows adapter
  // whose name can never be an IPv6 zone — the reading completes and every
  // address lands in exactly one bucket.
  expect(state.occupied.size + state.free.size + state.unevaluated.size).toBe(addresses.length);
  for (const address of addresses) {
    const buckets = [state.occupied.has(address), state.free.has(address), state.unevaluated.has(address)];
    expect(buckets.filter(Boolean).length).toBe(1);
  }
  // A port reserved and released moments ago is held by nobody, so nothing the
  // live probe sees is a widened bind.
  expect(newlyBoundNonLoopbackAddress(state, state)).toBeNull();
});

test("the live enumeration never carries a zone this platform cannot use", () => {
  for (const address of nonLoopbackProbeAddresses()) {
    const zone = address.includes("%") ? address.slice(address.indexOf("%") + 1) : null;
    if (zone === null) continue;
    expect(zone).not.toBe("");
    if (process.platform === "win32") expect(zone).toMatch(/^\d+$/);
  }
});

test("an address that appeared only after launch is still evidence, not an excuse", async () => {
  const port = await availablePort();
  const before = await readNonLoopbackBindState(port, {
    platform: "linux",
    addresses: [],
    listen: async () => {},
  });
  const after = await readNonLoopbackBindState(port, {
    platform: "linux",
    addresses: ["192.0.2.10"],
    listen: async () => {
      throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    },
  });

  // An interface that came up mid-launch was never observed free, but a
  // wildcard bind serves it too, and nothing excuses it. The guard fails closed.
  expect(newlyBoundNonLoopbackAddress(before, after)).toBe("192.0.2.10");
});
