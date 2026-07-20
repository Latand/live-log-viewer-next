import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";

interface ViewerRuntimeModule {
  registerViewerRuntime(): Promise<void>;
}

export async function registerNodeViewerRuntime(
  loadRuntime: () => Promise<ViewerRuntimeModule>,
): Promise<void> {
  discardWakatimeEnvironmentCredential();
  const { registerViewerRuntime } = await loadRuntime();
  await registerViewerRuntime();
}

/*
 * Thin Next.js instrumentation shim. This entry is compiled by EVERY dev
 * compiler — including the pages fallback compiler, which has no node:-scheme
 * support — so it must not reach any node: builtin, statically or dynamically,
 * outside the branch below. Webpack substitutes `process.env.NEXT_RUNTIME` per
 * compiler and prunes the statically-false branch at parse time (an early
 * `return` does NOT prune — dev builds run no minifier DCE), which is what
 * keeps `@/lib/viewerInstrumentation`'s node imports out of the fallback
 * compile. Regression symptom when broken: `UnhandledSchemeError: Reading from
 * "node:fs" …` at dev boot and a 500 on every request (local QA /api/files).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.NEXT_PHASE?.includes("build")) {
    await registerNodeViewerRuntime(() => import("@/lib/viewerInstrumentation"));
  }
}
