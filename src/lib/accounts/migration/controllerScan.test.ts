import { expect, test } from "bun:test";

import { accountControllerScan } from "./controller";

test("inventory sidecar reuses the Viewer snapshot without launching a corpus scan", async () => {
  const persisted = { files: [], projectCatalog: [], complete: true };
  let liveScans = 0;

  const snapshot = await accountControllerScan(
    { LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER: "1" },
    () => persisted,
    async () => {
      liveScans += 1;
      return { files: [], projectCatalog: [], complete: true };
    },
  );

  expect(snapshot).toBe(persisted);
  expect(liveScans).toBe(0);
});

test("inventory sidecar waits for the Viewer to publish its first snapshot", async () => {
  let liveScans = 0;

  const snapshot = await accountControllerScan(
    { LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER: "1" },
    () => undefined,
    async () => {
      liveScans += 1;
      return { files: [], projectCatalog: [], complete: true };
    },
  );

  expect(snapshot).toEqual({ files: [], projectCatalog: [], complete: false });
  expect(liveScans).toBe(0);
});
