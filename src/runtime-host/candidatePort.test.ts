import { expect, test } from "bun:test";

import { allocateBuiltCandidatePort, candidatePortsFromEnvironmentLists, selectCandidatePort } from "./candidatePort";

test("managed container environments reserve stopped rollback ports", () => {
  expect(candidatePortsFromEnvironmentLists([
    ["HOME=/home/latand", "PORT=18010"],
    ["PORT=18011", "PORT=invalid"],
    ["OTHER=value"],
  ])).toEqual(new Set([18_010, 18_011]));
});

test("candidate port selection skips occupied retained release ports", async () => {
  const probed: number[] = [];
  const selected = await selectCandidatePort("deploy-port-collision", {
    base: 18_000,
    slots: 5,
    isAvailable: async (port) => {
      probed.push(port);
      return probed.length === 3;
    },
  });

  expect(probed).toHaveLength(3);
  expect(selected).toBe(probed[2]);
  expect(new Set(probed).size).toBe(3);
});

test("candidate port selection fails after checking the bounded range", async () => {
  let probes = 0;
  await expect(selectCandidatePort("deploy-full-range", {
    base: 18_000,
    slots: 3,
    isAvailable: async () => { probes += 1; return false; },
  })).rejects.toThrow("no candidate Viewer port is available");
  expect(probes).toBe(3);
});

test("post-build allocation failure removes the image and Compose snapshot", async () => {
  const cleanup: string[] = [];
  await expect(allocateBuiltCandidatePort("deploy-inspect-failure", {
    base: 18_000,
    slots: 3,
    reservedPorts: async () => { throw new Error("container inspection failed"); },
    isAvailable: async () => true,
    removeImage: async () => { cleanup.push("image"); },
    removeComposeSnapshot: () => { cleanup.push("compose"); },
  })).rejects.toThrow("container inspection failed");

  expect(cleanup).toEqual(["image", "compose"]);
});
