import { afterAll } from "bun:test";

/**
 * Enable React's act(...) environment for a DOM test file, and — crucially —
 * reset it in `afterAll`. `IS_REACT_ACT_ENVIRONMENT` is a single global shared
 * across bun's one-process run, so a file that leaves it `true` makes every
 * later `flushSync`-based suite emit spurious "not wrapped in act(...)" warnings.
 * Registering the reset here keeps the flag scoped to the file that opts in.
 */
export function useActEnv(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
}
