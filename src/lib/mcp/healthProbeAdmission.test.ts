import { expect, test } from "bun:test";

import { admittedMcpHealthProbe } from "./healthProbeAdmission";

test("health admission trusts only a valid capability redeemed by the runtime host", async () => {
  const capability = "A".repeat(43);
  const admitted = {
    admitMcpHealthProbe: async (candidate: string) => candidate === capability,
  };

  expect(await admittedMcpHealthProbe(capability, admitted)).toBe(true);
  expect(await admittedMcpHealthProbe("self-selected", admitted)).toBe(false);
  expect(await admittedMcpHealthProbe(capability, null)).toBe(false);
  expect(await admittedMcpHealthProbe(capability, {
    admitMcpHealthProbe: async () => { throw new Error("runtime host unavailable"); },
  })).toBe(false);
});
