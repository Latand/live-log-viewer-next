import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Conditional standalone output keeps `bun run build && bun start` warning-free while packaging can still opt in.
  output: process.env.LLV_STANDALONE === "1" ? "standalone" : undefined,
  // Dev-only: hosts allowed to reach dev resources cross-origin (Tailscale/LAN preview).
  allowedDevOrigins: process.env.LLV_DEV_ORIGINS ? process.env.LLV_DEV_ORIGINS.split(",") : undefined,
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**"],
  },
  outputFileTracingIncludes: {
    "/*": [
      ".next/server/file-scanner-worker.js",
      ".next/server/files-response-worker.js",
      ".next/server/resource-collector-worker.js",
      ".next/server/account-migration-controller-worker.js",
      ".next/server/wakatime-sync-worker.js",
      ".next/server/chunks/**",
    ],
  },
  webpack(config, { isServer, nextRuntime }) {
    if (isServer && nextRuntime === "nodejs") {
      const originalEntry = config.entry;
      config.entry = async () => ({
        ...(typeof originalEntry === "function" ? await originalEntry() : originalEntry),
        "file-scanner-worker": "./src/lib/fileScanner.worker.ts",
        "files-response-worker": "./src/lib/filesResponse.worker.ts",
        "resource-collector-worker": "./src/lib/resourceCollector.worker.ts",
        "account-migration-controller-worker": "./src/lib/accountMigrationController.worker.ts",
        "wakatime-sync-worker": "./src/lib/wakatimeSync.worker.ts",
      });
    }
    return config;
  },
};

export default nextConfig;
