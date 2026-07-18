const startupStore = globalThis as typeof globalThis & {
  __llvStructuredHostStartupFailed?: boolean;
};

export function markStructuredHostStartupFailed(): void {
  startupStore.__llvStructuredHostStartupFailed = true;
}

export function markStructuredHostStartupReady(): void {
  startupStore.__llvStructuredHostStartupFailed = false;
}

export function didStructuredHostStartupFail(): boolean {
  return startupStore.__llvStructuredHostStartupFailed === true;
}

/** Truthful readiness axis for operator surfaces: "ready" only after startup
    adoption succeeded, "failed" after it failed, "pending" before either, and
    null when structured hosting is disabled. Production #367 reported ready
    health while structured spawn admission was failing end to end. */
export function structuredStartupAxis(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "ready" | "failed" | "pending" | null {
  if (env.LLV_STRUCTURED_HOSTS !== "1") return null;
  const failed = startupStore.__llvStructuredHostStartupFailed;
  if (failed === undefined) return "pending";
  return failed ? "failed" : "ready";
}
