import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ViewerMcpRuntimeIdentity, ViewerReleaseIdentity } from "@/lib/runtime/contracts";

export type McpRuntimePublicationBoundary =
  | "before-release-rename"
  | "after-release-rename"
  | "before-launcher-rename"
  | "after-launcher-rename"
  | "before-target-rename"
  | "after-target-rename";

export interface McpRuntimeLauncherPublicationEvidence {
  executablePath: string;
  launcherDigest: string;
  publishedAt: string;
  durable: true;
}

export interface McpRuntimeReleaseStoreOptions {
  stateDir: string;
  stableRuntimeRoot: string;
  now?: () => string;
  publicationBoundary?: (boundary: McpRuntimePublicationBoundary) => void;
}

function syncDirectory(dirname: string): void {
  const fd = fs.openSync(dirname, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncTree(dirname: string): void {
  for (const entry of fs.readdirSync(dirname, { withFileTypes: true })) {
    const filename = path.join(dirname, entry.name);
    if (entry.isDirectory()) {
      syncTree(filename);
      continue;
    }
    if (!entry.isFile()) continue;
    const fd = fs.openSync(filename, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  syncDirectory(dirname);
}

/* Staging temp directories are named `.<releaseId>.<pid>.<uuid>.tmp`. A crash
   leaves one behind carrying a whole copied node_modules, and the next
   deployment has a different releaseId — so the sweep matches the shape, never
   one deployment's own id. */
function isStagingTemporary(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".tmp");
}

function releaseId(deploymentId: string, revision: string): string {
  const digest = createHash("sha256").update(`${deploymentId}\0${revision}`).digest("hex").slice(0, 24);
  return `deploy-${digest}`;
}

function bundleDigest(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function runtimeIdentity(value: unknown): ViewerMcpRuntimeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP runtime release manifest is invalid");
  const runtime = value as Partial<ViewerMcpRuntimeIdentity>;
  if (runtime.source !== "managed"
    || typeof runtime.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(runtime.revision)
    || typeof runtime.releaseId !== "string"
    || !/^[a-z0-9-]+$/.test(runtime.releaseId)
    || typeof runtime.artifactDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(runtime.artifactDigest)
    || typeof runtime.stagedAt !== "string") {
    throw new Error("MCP runtime release manifest is invalid");
  }
  return runtime as ViewerMcpRuntimeIdentity;
}

export class McpRuntimeReleaseStore {
  private readonly releasesDir: string;
  private readonly now: () => string;

  constructor(private readonly options: McpRuntimeReleaseStoreOptions) {
    this.releasesDir = path.join(options.stateDir, "mcp-runtime", "releases");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  releaseRoot(runtime: ViewerMcpRuntimeIdentity): string {
    if (runtime.source !== "managed" || !runtime.releaseId || !/^[a-z0-9-]+$/.test(runtime.releaseId)) {
      throw new Error("managed MCP runtime release identity is required");
    }
    return path.join(this.releasesDir, runtime.releaseId);
  }

  legacyRuntimeIdentity(revision: string): ViewerMcpRuntimeIdentity {
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("legacy MCP runtime revision is invalid");
    return {
      source: "legacy",
      revision,
      releaseId: null,
      artifactDigest: createHash("sha256").update(`legacy-mcp-runtime\0${revision}`).digest("hex"),
      stagedAt: null,
    };
  }

  retire(runtime: ViewerMcpRuntimeIdentity): void {
    if (runtime.source !== "managed") return;
    fs.rmSync(this.releaseRoot(runtime), { recursive: true, force: true });
    if (fs.existsSync(this.releasesDir)) syncDirectory(this.releasesDir);
  }

  retainOnly(runtimes: ViewerMcpRuntimeIdentity[]): void {
    if (!fs.existsSync(this.releasesDir)) return;
    const retained = new Set(runtimes
      .filter((runtime) => runtime.source === "managed")
      .map((runtime) => runtime.releaseId));
    for (const entry of fs.readdirSync(this.releasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (isStagingTemporary(entry.name)) {
        fs.rmSync(path.join(this.releasesDir, entry.name), { recursive: true, force: true });
        continue;
      }
      if (entry.name.startsWith(".") || retained.has(entry.name)) continue;
      if (!/^[a-z0-9-]+$/.test(entry.name)) throw new Error("managed MCP runtime release directory is invalid");
      fs.rmSync(path.join(this.releasesDir, entry.name), { recursive: true, force: true });
    }
    syncDirectory(this.releasesDir);
  }

  publishReleaseTarget(filename: string, target: ViewerReleaseIdentity): void {
    const targetDirectory = path.dirname(filename);
    const targetName = path.basename(filename);
    fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(targetDirectory)) {
      if (entry.startsWith(`${targetName}.`) && entry.endsWith(".tmp")) {
        fs.rmSync(path.join(targetDirectory, entry), { force: true });
      }
    }
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(target));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      this.options.publicationBoundary?.("before-target-rename");
      fs.renameSync(temporary, filename);
      this.options.publicationBoundary?.("after-target-rename");
      syncDirectory(targetDirectory);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  installStableLauncher(sourceRoot: string): McpRuntimeLauncherPublicationEvidence {
    const sourceBin = path.join(sourceRoot, "bin");
    const sourceLauncher = path.join(sourceBin, "mcp-server.mjs");
    const sourceRuntime = path.join(sourceBin, "server-runtime.mjs");
    if (!fs.statSync(sourceLauncher).isFile() || !fs.statSync(sourceRuntime).isFile()) {
      throw new Error("prepared MCP runtime launcher is incomplete");
    }
    const targetBin = path.join(this.options.stableRuntimeRoot, "bin");
    fs.mkdirSync(targetBin, { recursive: true, mode: 0o700 });
    this.publishExecutable(sourceRuntime, path.join(targetBin, "server-runtime.mjs"));

    const targetLauncher = path.join(targetBin, "mcp-server.mjs");
    const temporary = `${targetLauncher}.${process.pid}.${randomUUID()}.tmp`;
    for (const entry of fs.readdirSync(targetBin)) {
      if (entry.startsWith("mcp-server.mjs.") && entry.endsWith(".tmp")) {
        fs.rmSync(path.join(targetBin, entry), { force: true });
      }
    }
    const fd = fs.openSync(temporary, "wx", 0o755);
    try {
      fs.writeFileSync(fd, fs.readFileSync(sourceLauncher));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      this.options.publicationBoundary?.("before-launcher-rename");
      fs.renameSync(temporary, targetLauncher);
      this.options.publicationBoundary?.("after-launcher-rename");
      syncDirectory(targetBin);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    return {
      executablePath: targetLauncher,
      launcherDigest: bundleDigest(targetLauncher),
      publishedAt: this.now(),
      durable: true,
    };
  }

  stagePreparedPackage(sourceRoot: string, deploymentId: string, revision: string): ViewerMcpRuntimeIdentity {
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("MCP runtime revision is invalid");
    const id = releaseId(deploymentId, revision);
    const finalRoot = path.join(this.releasesDir, id);
    const existing = this.readManagedRelease(finalRoot);
    if (existing) {
      if (existing.releaseId !== id || existing.revision !== revision) {
        throw new Error("existing MCP runtime release does not match the requested deployment");
      }
      return existing;
    }

    const sourceBundle = path.join(sourceRoot, "dist", "mcp-server.mjs");
    const sourceModules = path.join(sourceRoot, "node_modules");
    const sourcePackage = path.join(sourceRoot, "package.json");
    if (!fs.statSync(sourceBundle).isFile()
      || !fs.statSync(sourceModules).isDirectory()
      || !fs.statSync(sourcePackage).isFile()) {
      throw new Error("prepared MCP runtime package is incomplete");
    }

    fs.mkdirSync(this.releasesDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(this.releasesDir)) {
      if (isStagingTemporary(entry)) {
        fs.rmSync(path.join(this.releasesDir, entry), { recursive: true, force: true });
      }
    }
    const temporary = path.join(this.releasesDir, `.${id}.${process.pid}.${randomUUID()}.tmp`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    try {
      fs.cpSync(path.join(sourceRoot, "dist"), path.join(temporary, "dist"), { recursive: true });
      fs.cpSync(sourceModules, path.join(temporary, "node_modules"), { recursive: true });
      fs.copyFileSync(sourcePackage, path.join(temporary, "package.json"));
      const runtime: ViewerMcpRuntimeIdentity = {
        source: "managed",
        revision,
        releaseId: id,
        artifactDigest: bundleDigest(path.join(temporary, "dist", "mcp-server.mjs")),
        stagedAt: this.now(),
      };
      fs.writeFileSync(path.join(temporary, "runtime-release.json"), JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
      syncTree(temporary);
      this.options.publicationBoundary?.("before-release-rename");
      fs.renameSync(temporary, finalRoot);
      this.options.publicationBoundary?.("after-release-rename");
      syncDirectory(this.releasesDir);
      return runtime;
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private readManagedRelease(releaseRoot: string): ViewerMcpRuntimeIdentity | null {
    try {
      const runtime = runtimeIdentity(JSON.parse(fs.readFileSync(path.join(releaseRoot, "runtime-release.json"), "utf8")));
      if (!fs.statSync(path.join(releaseRoot, "node_modules")).isDirectory()
        || !fs.statSync(path.join(releaseRoot, "package.json")).isFile()) {
        throw new Error("MCP runtime release package is incomplete");
      }
      if (bundleDigest(path.join(releaseRoot, "dist", "mcp-server.mjs")) !== runtime.artifactDigest) {
        throw new Error("MCP runtime release bundle digest does not match its manifest");
      }
      return runtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private publishExecutable(source: string, target: string): void {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o755);
    try {
      fs.writeFileSync(fd, fs.readFileSync(source));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, target);
      syncDirectory(path.dirname(target));
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}
