import { performance } from "node:perf_hooks";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_TIME_BUDGET_MS = 32;

export interface CooperativeBatchOptions {
  batchSize?: number;
  timeBudgetMs?: number;
}

export function yieldToRuntime(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function forEachCooperatively<T>(
  values: readonly T[],
  visit: (value: T, index: number) => void | Promise<void>,
  options: CooperativeBatchOptions = {},
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  let batchStartedAt = performance.now();
  let batchCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    await visit(values[index]!, index);
    batchCount += 1;
    if (index + 1 >= values.length) continue;
    if (batchCount < batchSize && performance.now() - batchStartedAt < timeBudgetMs) continue;
    await yieldToRuntime();
    batchStartedAt = performance.now();
    batchCount = 0;
  }
}

export async function mapCooperatively<T, U>(
  values: readonly T[],
  visit: (value: T, index: number) => U | Promise<U>,
  options: CooperativeBatchOptions = {},
): Promise<U[]> {
  const mapped = new Array<U>(values.length);
  await forEachCooperatively(values, async (value, index) => {
    mapped[index] = await visit(value, index);
  }, options);
  return mapped;
}
