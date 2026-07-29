import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RegistryBackendMode = "off" | "dual-write" | "read" | "sqlite";

export const REGISTRY_BACKEND_ENV = "LLV_AGENT_REGISTRY_SQLITE";

/** Only the one variable is read, so tests need not fabricate a whole env. */
export type RegistryBackendEnvironment = Readonly<Record<string, string | undefined>>;
export const REGISTRY_BACKEND_DESCRIPTOR_VERSION = 1;

/** A reader could not prove which backend the writer owns. Every construction
    path treats this as fatal: reading the JSON mirror while SQLite is (or may
    be) authoritative is exactly the silent divergence this descriptor exists
    to prevent — a reader that resolves a stale mirror sees dead host pids and
    reports every MCP caller as unidentified. */
export class RegistryBackendIdentityError extends Error {
  override name = "RegistryBackendIdentityError";
}

export interface RegistryBackendDescriptor {
  schemaVersion: number;
  mode: RegistryBackendMode;
  /** Bare filename resolved against the descriptor's own directory, so the
      record carries no absolute path and survives host/container path skew. */
  sqliteFile: string | null;
  publishedAt: string;
}

export interface RegistryBackendResolution {
  mode: RegistryBackendMode;
  /** The store the writer named. `null` leaves the default to the caller. */
  sqliteFilename: string | null;
  source: "environment" | "descriptor" | "json-only" | "explicit" | "unmanaged";
}

/** The filesystem seam. Tests drive unreadable and contradictory states
    without depending on the runner's uid or umask. */
export interface RegistryBackendIo {
  /** `null` means absent; any other failure must throw. */
  readText(filename: string): string | null;
  exists(filename: string): boolean;
  writeText(filename: string, contents: string): void;
}

export const nodeRegistryBackendIo: RegistryBackendIo = {
  readText(filename) {
    try {
      return fs.readFileSync(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new RegistryBackendIdentityError(
        `${path.basename(filename)} is unreadable: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
      );
    }
  },
  exists(filename) {
    return fs.existsSync(filename);
  },
  writeText(filename, contents) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filename);
  },
};

export function registryBackendDescriptorPath(registryFilename: string): string {
  const base = path.basename(registryFilename).replace(/\.json$/, "");
  return path.join(path.dirname(registryFilename), `${base}.backend.json`);
}

export function defaultRegistrySqliteFilename(registryFilename: string): string {
  return registryFilename.endsWith(".json")
    ? `${registryFilename.slice(0, -5)}.sqlite`
    : `${registryFilename}.sqlite`;
}

function isBackendMode(value: unknown): value is RegistryBackendMode {
  return value === "off" || value === "dual-write" || value === "read" || value === "sqlite";
}

/** Pure env read: lets health/capability probes answer without paying the
    full registry load (a multi-MB JSON parse) on first touch. */
export function registryBackendModeFromEnvironment(
  environment: RegistryBackendEnvironment = process.env,
): RegistryBackendMode {
  const configured = environment[REGISTRY_BACKEND_ENV] ?? "off";
  if (isBackendMode(configured)) return configured;
  throw new Error(`${REGISTRY_BACKEND_ENV} must be off, dual-write, read, or sqlite`);
}

function parseDescriptor(raw: string, label: string): RegistryBackendDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new RegistryBackendIdentityError(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RegistryBackendIdentityError(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== REGISTRY_BACKEND_DESCRIPTOR_VERSION) {
    throw new RegistryBackendIdentityError(
      `${label} declares schema version ${String(record.schemaVersion)}, but this build understands ${REGISTRY_BACKEND_DESCRIPTOR_VERSION}`,
    );
  }
  if (!isBackendMode(record.mode)) {
    throw new RegistryBackendIdentityError(`${label} declares an unknown backend mode`);
  }
  const sqliteFile = record.sqliteFile;
  if (sqliteFile !== null && typeof sqliteFile !== "string") {
    throw new RegistryBackendIdentityError(`${label} declares an invalid store filename`);
  }
  /* A bare name only: the descriptor must never be able to point a reader at
     a store outside the state directory it lives in. */
  if (typeof sqliteFile === "string" && (sqliteFile === "" || sqliteFile !== path.basename(sqliteFile))) {
    throw new RegistryBackendIdentityError(`${label} must name its store as a bare filename`);
  }
  if (record.mode !== "off" && sqliteFile === null) {
    throw new RegistryBackendIdentityError(`${label} declares the ${record.mode} backend but names no store`);
  }
  return {
    schemaVersion: REGISTRY_BACKEND_DESCRIPTOR_VERSION,
    mode: record.mode,
    sqliteFile: sqliteFile ?? null,
    publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : "",
  };
}

/**
 * Which backend this process must open.
 *
 * A writer states its mode in the environment and is authoritative. Every
 * other process — most importantly the MCP server, which Claude launches with
 * an empty env — resolves the durable descriptor the writer published, so a
 * reader can never silently open a different store than the writer owns.
 *
 * Absent, invalid, contradictory, and unavailable identities all fail closed.
 * The one safe fallback is a deployment that genuinely has no SQLite store:
 * there is nothing to diverge from, so the JSON backend is proven, not assumed.
 */
export function resolveRegistryBackend(
  registryFilename: string,
  environment: RegistryBackendEnvironment = process.env,
  io: RegistryBackendIo = nodeRegistryBackendIo,
): RegistryBackendResolution {
  if (environment[REGISTRY_BACKEND_ENV] !== undefined) {
    return { mode: registryBackendModeFromEnvironment(environment), sqliteFilename: null, source: "environment" };
  }
  const descriptorPath = registryBackendDescriptorPath(registryFilename);
  const descriptorName = path.basename(descriptorPath);
  const defaultStore = defaultRegistrySqliteFilename(registryFilename);
  const raw = io.readText(descriptorPath);
  if (raw === null) {
    if (io.exists(defaultStore)) {
      throw new RegistryBackendIdentityError(
        `the agent registry backend identity is unpublished while ${path.basename(defaultStore)} exists,`
        + ` so SQLite may be authoritative and the JSON mirror may be stale;`
        + ` start the registry writer with ${REGISTRY_BACKEND_ENV} set so it publishes ${descriptorName}`,
      );
    }
    return { mode: "off", sqliteFilename: null, source: "json-only" };
  }
  const descriptor = parseDescriptor(raw, descriptorName);
  if (descriptor.mode === "off") {
    if (io.exists(defaultStore)) {
      throw new RegistryBackendIdentityError(
        `${descriptorName} claims the JSON backend while ${path.basename(defaultStore)} exists;`
        + ` remove the stale store or republish the descriptor from the writer`,
      );
    }
    return { mode: "off", sqliteFilename: null, source: "descriptor" };
  }
  const store = path.join(path.dirname(descriptorPath), descriptor.sqliteFile!);
  if (!io.exists(store)) {
    throw new RegistryBackendIdentityError(
      `${descriptorName} names the ${descriptor.mode} backend store ${descriptor.sqliteFile}, which is unavailable`,
    );
  }
  return { mode: descriptor.mode, sqliteFilename: store, source: "descriptor" };
}

/** Publishes the writer's own backend identity. Idempotent: an unchanged
    identity is left alone so readers never observe a torn rewrite, and a
    corrupt descriptor is replaced rather than trusted. */
export function publishRegistryBackendIdentity(
  registryFilename: string,
  mode: RegistryBackendMode,
  sqliteFilename: string,
  io: RegistryBackendIo = nodeRegistryBackendIo,
  now: () => string = () => new Date().toISOString(),
): void {
  const descriptorPath = registryBackendDescriptorPath(registryFilename);
  const sqliteFile = mode === "off" ? null : path.basename(sqliteFilename);
  const existing = io.readText(descriptorPath);
  if (existing !== null) {
    try {
      const current = parseDescriptor(existing, path.basename(descriptorPath));
      if (current.mode === mode && current.sqliteFile === sqliteFile) return;
    } catch {
      /* An unreadable identity is worse than no identity: republish it. */
    }
  }
  const descriptor: RegistryBackendDescriptor = {
    schemaVersion: REGISTRY_BACKEND_DESCRIPTOR_VERSION,
    mode,
    sqliteFile,
    publishedAt: now(),
  };
  io.writeText(descriptorPath, `${JSON.stringify(descriptor)}\n`);
}
