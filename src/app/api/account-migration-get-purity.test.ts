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
registry.beginSpawn("codex", "/repo");
const getFiles = (request: Request) => buildFilesResponse(request, {
  listFilesWithProjectCatalog: async () => ({ files: [], projectCatalog: [], complete: true }),
});

function stateBytes(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(pathname);
      else if (entry.isFile()) files[path.relative(root, pathname)] = fs.readFileSync(pathname).toString("base64");
    }
  };
  walk(root);
  return files;
}

beforeEach(() => setAgentRegistryForTests(registry));
afterEach(() => setAgentRegistryForTests(null));

afterAll(() => {
  if (oldState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = oldState;
  fs.rmSync(root, { recursive: true, force: true });
});

test("GET accounts and files preserve registry bytes exactly", async () => {
  const before = stateBytes();
  const accounts = await getAccounts();
  expect(accounts.status).toBe(200);
  expect(stateBytes()).toEqual(before);

  const files = await getFiles(new Request("http://127.0.0.1/api/files"));
  expect(files.status).toBe(200);
  expect(stateBytes()).toEqual(before);
}, 15_000);

test("conditional GET keeps the same durable bytes", async () => {
  const first = await getFiles(new Request("http://127.0.0.1/api/files"));
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();
  const before = stateBytes();
  const second = await getFiles(new Request("http://127.0.0.1/api/files", { headers: { "if-none-match": etag! } }));
  expect(second.status).toBe(304);
  expect(stateBytes()).toEqual(before);
}, 15_000);
