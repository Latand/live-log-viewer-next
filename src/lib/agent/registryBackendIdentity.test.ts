import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RegistryBackendIdentityError,
  publishRegistryBackendIdentity,
  registryBackendDescriptorPath,
  resolveRegistryBackend,
  type RegistryBackendIo,
} from "./registryBackendIdentity";

const roots: string[] = [];

function stateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-backend-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function registryFile(root: string): string {
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify({ entries: {} }));
  return filename;
}

function withStore(root: string): string {
  const store = path.join(root, "agent-registry.sqlite");
  fs.writeFileSync(store, "");
  return store;
}

/* The production defect, reduced: Claude launches the MCP server with an empty
   env, so the reader saw `off` and opened the JSON mirror while the writer
   owned SQLite. Every host pid it then read was dead, and caller authority
   reported every MCP caller as unidentified. */
test("an MCP reader with no env resolves the writer's SQLite backend, not the JSON mirror", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);

  const resolved = resolveRegistryBackend(filename, {});

  expect(resolved).toEqual({ mode: "sqlite", sqliteFilename: store, source: "descriptor" });
});

test("a stale JSON mirror is never chosen when the descriptor names SQLite", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);
  /* A mirror far behind the store is exactly the state that produced dead
     host pids in production; resolution must not even consider it. */
  fs.writeFileSync(filename, JSON.stringify({ entries: {}, _sqliteRevision: 1 }));

  expect(resolveRegistryBackend(filename, {}).mode).toBe("sqlite");
});

test("an explicit environment overrides the descriptor and stays authoritative", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);

  const resolved = resolveRegistryBackend(filename, { LLV_AGENT_REGISTRY_SQLITE: "sqlite" });

  expect(resolved).toEqual({ mode: "sqlite", sqliteFilename: null, source: "environment" });
});

test("a genuine JSON-only deployment keeps working without a descriptor", () => {
  const root = stateRoot();
  const filename = registryFile(root);

  const resolved = resolveRegistryBackend(filename, {});

  expect(resolved).toEqual({ mode: "off", sqliteFilename: null, source: "json-only" });
});

test("a descriptor that declares the JSON backend resolves off when no store exists", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  publishRegistryBackendIdentity(filename, "off", path.join(root, "unused.sqlite"));

  expect(resolveRegistryBackend(filename, {})).toEqual({ mode: "off", sqliteFilename: null, source: "descriptor" });
});

test("an unpublished identity beside an existing store fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);

  expect(() => resolveRegistryBackend(filename, {})).toThrow(RegistryBackendIdentityError);
  expect(() => resolveRegistryBackend(filename, {})).toThrow(/unpublished while agent-registry\.sqlite exists/);
});

test("a descriptor contradicted by an existing store fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  publishRegistryBackendIdentity(filename, "off", path.join(root, "unused.sqlite"));
  withStore(root);

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/claims the JSON backend while agent-registry\.sqlite exists/);
});

test("a descriptor naming an unavailable store fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);
  fs.rmSync(store);

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/which is unavailable/);
});

test("a corrupt descriptor fails closed instead of falling back", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(registryBackendDescriptorPath(filename), "{not json");

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/is not valid JSON/);
});

test("a descriptor from a future schema fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(
    registryBackendDescriptorPath(filename),
    JSON.stringify({ schemaVersion: 2, mode: "sqlite", sqliteFile: "agent-registry.sqlite", publishedAt: "" }),
  );

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/schema version 2/);
});

test("a descriptor declaring an unknown mode fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(
    registryBackendDescriptorPath(filename),
    JSON.stringify({ schemaVersion: 1, mode: "postgres", sqliteFile: "agent-registry.sqlite", publishedAt: "" }),
  );

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/unknown backend mode/);
});

test("a descriptor cannot point a reader outside its own state directory", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(
    registryBackendDescriptorPath(filename),
    JSON.stringify({ schemaVersion: 1, mode: "sqlite", sqliteFile: "../elsewhere.sqlite", publishedAt: "" }),
  );

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/bare filename/);
});

test("an unreadable descriptor fails closed rather than reading as absent", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  const io: RegistryBackendIo = {
    readText: () => { throw new RegistryBackendIdentityError("agent-registry.backend.json is unreadable: EACCES"); },
    exists: () => true,
    writeText: () => { throw new Error("unexpected write"); },
  };

  expect(() => resolveRegistryBackend(filename, {}, io)).toThrow(/unreadable: EACCES/);
});

test("publishing is idempotent and replaces a corrupt identity", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  const descriptorPath = registryBackendDescriptorPath(filename);

  publishRegistryBackendIdentity(filename, "sqlite", store, undefined, () => "first");
  publishRegistryBackendIdentity(filename, "sqlite", store, undefined, () => "second");
  expect(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).publishedAt).toBe("first");

  fs.writeFileSync(descriptorPath, "{corrupt");
  publishRegistryBackendIdentity(filename, "sqlite", store, undefined, () => "third");
  expect(JSON.parse(fs.readFileSync(descriptorPath, "utf8"))).toMatchObject({
    schemaVersion: 1,
    mode: "sqlite",
    sqliteFile: "agent-registry.sqlite",
    publishedAt: "third",
  });
});
