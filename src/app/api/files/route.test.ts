import { expect, mock, test } from "bun:test";

let scans = 0;
let scanOptions: unknown;

mock.module("@/lib/scanner", () => ({
  listFilesWithProjectCatalog: async (_project: string | undefined, options: unknown) => {
    scans += 1;
    scanOptions = options;
    return { files: [], projectCatalog: [] };
  },
}));
mock.module("@/lib/flows/store", () => ({ loadFlows: () => [] }));
mock.module("@/lib/tasks/store", () => ({
  loadTasks: () => [],
  mutateTasks: () => { throw new Error("files route attempted a task mutation"); },
}));
mock.module("@/lib/workflows/store", () => ({ loadWorkflows: () => [] }));
mock.module("@/lib/workflows/visibility", () => ({ filterWorkflowsForFileScan: () => [] }));

const { GET } = await import("./route");

test("repeated files reads execute only pure read ports and retain ETag behavior", async () => {
  scans = 0;
  const first = await GET(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");
  const second = await GET(new Request("http://127.0.0.1/api/files", { headers: { "if-none-match": etag! } }));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ files: [], projectCatalog: [], flows: [], workflows: [], tasks: [] });
  expect(second.status).toBe(304);
  expect(scans).toBe(2);
  expect(scanOptions).toEqual({ persist: false });
});
