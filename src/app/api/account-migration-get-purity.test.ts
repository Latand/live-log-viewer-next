import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-get-purity-"));
const oldState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = root;
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { GET: getAccounts } = await import("@/app/api/accounts/route");
const { buildFilesResponse } = await import("@/app/api/files/response");
const registry = new AgentRegistry(path.join(root, "registry.json"));
registry.beginSpawn("codex", "/repo", { title: "Verify account migration GET purity" });
const getFiles = (request: Request) => buildFilesResponse(request, {
  listFilesWithProjectCatalog: async () => ({ files: [], projectCatalog: [], complete: true }),
});

function registryBytes(): string {
  return fs.readFileSync(path.join(root, "registry.json")).toString("base64");
}

beforeEach(() => setAgentRegistryForTests(registry));
afterEach(() => setAgentRegistryForTests(null));

afterAll(() => {
  if (oldState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = oldState;
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET accounts and files preserve registry bytes exactly", async () => {
  const before = registryBytes();
  const accounts = await getAccounts();
  expect(accounts.status).toBe(200);
  expect(registryBytes()).toEqual(before);

  const files = await getFiles(new Request("http://127.0.0.1/api/files"));
  expect(files.status).toBe(200);
  expect(registryBytes()).toEqual(before);
}, 15_000);

test("conditional GET keeps the same durable bytes", async () => {
  const first = await getFiles(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();
  const before = registryBytes();
  const second = await getFiles(new Request("http://127.0.0.1/api/files", { headers: { "if-none-match": etag! } }));
  expect(second.status).toBe(304);
  expect(registryBytes()).toEqual(before);
}, 15_000);
