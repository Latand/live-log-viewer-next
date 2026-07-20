export const COMPOSER_ADMISSION_DEADLINE_MS = 15_000;
export const COMPOSER_RECEIPT_RECONCILIATION_MS = 30_000;
export const COMPOSER_RECEIPT_POLL_INTERVAL_MS = 1_000;

export class ComposerAdmissionTimeoutError extends Error {
  constructor() {
    super("composer admission timed out");
    this.name = "ComposerAdmissionTimeoutError";
  }
}

/**
 * Bounds how long the composer blocks on the immediate HTTP response.
 *
 * The request continues in the background because the server may have already
 * accepted it. Durable receipt reconciliation owns the eventual settlement;
 * the deadline releases the busy state while the original key remains fenced.
 */
export function withComposerAdmissionDeadline<T>(request: Promise<T>, timeoutMs = COMPOSER_ADMISSION_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ComposerAdmissionTimeoutError()), timeoutMs);
  });
  return Promise.race([request, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface ComposerReceiptReconciliation<T> {
  read: () => T | null;
  refresh: () => Promise<boolean>;
  late?: Promise<T | null>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function refreshBeforeDeadline(
  refresh: () => Promise<boolean>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
    void refresh().then(finish, finish);
  });
}

/** Polls the authoritative runtime snapshot for a receipt after the immediate
 * admission response misses its deadline. The original send remains owned by
 * its caller, so this loop never issues another actuation. */
export async function reconcileComposerReceipt<T>({
  read,
  refresh,
  late,
  timeoutMs = COMPOSER_RECEIPT_RECONCILIATION_MS,
  pollIntervalMs = COMPOSER_RECEIPT_POLL_INTERVAL_MS,
  signal,
}: ComposerReceiptReconciliation<T>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  const pendingForever = new Promise<never>(() => {});
  const lateReceipt: Promise<T> = late
    ? late.then((value) => value ?? pendingForever, () => pendingForever)
    : pendingForever;
  while (!signal?.aborted) {
    const current = read();
    if (current !== null) return current;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const refreshed = await Promise.race([
      refreshBeforeDeadline(refresh, remaining, signal).then(read),
      lateReceipt,
    ]);
    if (refreshed !== null) return refreshed;
    const afterWait = await Promise.race([
      waitFor(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal).then(read),
      lateReceipt,
    ]);
    if (afterWait !== null) return afterWait;
  }
  return null;
}
