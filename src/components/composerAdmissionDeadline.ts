export const COMPOSER_ADMISSION_DEADLINE_MS = 15_000;

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
 * the deadline only releases the input so the operator can retry with the same
 * idempotency key.
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
