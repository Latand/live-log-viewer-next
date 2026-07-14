import { expect, test } from "bun:test";

test("separate bundle module instances share structured startup status", async () => {
  const moduleCopy = (name: string) => `./startupStatus?${name}`;
  const instrumentationCopy = await import(moduleCopy("instrumentation-copy"));
  const routeCopy = await import(moduleCopy("route-copy"));
  try {
    instrumentationCopy.markStructuredHostStartupFailed();
    expect(routeCopy.didStructuredHostStartupFail()).toBe(true);
    routeCopy.markStructuredHostStartupReady();
    expect(instrumentationCopy.didStructuredHostStartupFail()).toBe(false);
  } finally {
    instrumentationCopy.markStructuredHostStartupReady();
  }
});
