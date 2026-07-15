export interface FreshAwareCoalescer<T> {
  run(fresh: boolean, work: (fresh: boolean) => Promise<T>): Promise<T>;
}

/** Shares concurrent work while preserving the ordering of a forced refresh.
    Ordinary callers join any active operation. A fresh caller joins an active
    fresh operation or waits for ordinary work before starting one refresh. */
export function createFreshAwareCoalescer<T>(): FreshAwareCoalescer<T> {
  let active: { fresh: boolean; promise: Promise<T> } | null = null;

  return {
    async run(fresh, work) {
      for (;;) {
        const current = active;
        if (current) {
          if (!fresh || current.fresh) return current.promise;
          try {
            await current.promise;
          } catch {
            /* A forced refresh still gets its own attempt after an ordinary
               operation fails. The ordinary caller receives that failure. */
          }
          if (active === current) active = null;
          continue;
        }

        const promise = Promise.resolve().then(() => work(fresh));
        const operation = { fresh, promise };
        active = operation;
        try {
          return await promise;
        } finally {
          if (active === operation) active = null;
        }
      }
    },
  };
}
