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
    "/*": [".next/server/resource-collector-worker.js"],
  },
  webpack(config, { isServer, nextRuntime }) {
    if (isServer && nextRuntime === "nodejs") {
      const originalEntry = config.entry;
      config.entry = async () => ({
        ...(typeof originalEntry === "function" ? await originalEntry() : originalEntry),
        "resource-collector-worker": "./src/lib/resourceCollector.worker.ts",
      });
    }
    return config;
  },
};

export default nextConfig;
