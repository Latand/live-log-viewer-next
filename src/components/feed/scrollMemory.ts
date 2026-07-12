/** A fixed-size recency map for lightweight per-conversation UI memory. */
export class BoundedLru<Value> {
  private readonly values = new Map<string, Value>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("BoundedLru limit must be a positive integer");
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): Value | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) return;
      this.values.delete(oldest);
    }
  }
}
