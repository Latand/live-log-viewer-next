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
