/** Bound independent historical I/O and join every started operation before
 * propagating failure. Admission must never outlive an unobserved worker. */
export async function forEachStartupBatch<T>(
  items: readonly T[],
  visit: (item: T) => Promise<void>,
  assertActive: () => void = () => {},
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 16) {
    assertActive();
    const outcomes = await Promise.allSettled(items.slice(offset, offset + 16).map(visit));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    assertActive();
  }
}
