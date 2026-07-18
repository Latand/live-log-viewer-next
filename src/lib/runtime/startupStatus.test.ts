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

test("issue 367: the structured startup axis never reports ready before adoption succeeds", async () => {
  const { markStructuredHostStartupFailed, markStructuredHostStartupReady, structuredStartupAxis } = await import(`./startupStatus?${"axis-copy"}`);
  const store = globalThis as typeof globalThis & { __llvStructuredHostStartupFailed?: boolean };
  const previous = store.__llvStructuredHostStartupFailed;
  try {
    delete store.__llvStructuredHostStartupFailed;
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "1" })).toBe("pending");
    markStructuredHostStartupFailed();
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "1" })).toBe("failed");
    markStructuredHostStartupReady();
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "1" })).toBe("ready");
    expect(structuredStartupAxis({})).toBeNull();
  } finally {
    if (previous === undefined) delete store.__llvStructuredHostStartupFailed;
    else store.__llvStructuredHostStartupFailed = previous;
  }
});
