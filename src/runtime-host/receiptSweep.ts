/* #1216. The producer-receipt sweep runs every 10s and used to print a line on
   every cycle that removed anything, which on a busy journal is a line every
   ten seconds forever — enough to bury a whole deployment in the same stream.
   The per-cycle detail is now debug-only, and the default stream carries one
   aggregated line per window so the sweep stays observable without drowning
   anything else. */
export const RECEIPT_SWEEP_SUMMARY_INTERVAL_MS = 15 * 60_000;

export interface ReceiptSweepPass {
  scanned: number;
  deleted: number;
  cycled: boolean;
}

export interface ReceiptSweepReporterOptions {
  debug?: boolean;
  summaryIntervalMs?: number;
}

export function receiptSweepDebugEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.LLV_RUNTIME_JOURNAL_DEBUG === "1";
}

export class ReceiptSweepReporter {
  private deleted = 0;
  private cycles = 0;
  private windowStartedAt: number | null = null;
  private readonly debug: boolean;
  private readonly summaryIntervalMs: number;

  constructor(options: ReceiptSweepReporterOptions = {}) {
    this.debug = options.debug ?? false;
    this.summaryIntervalMs = Math.max(0, options.summaryIntervalMs ?? RECEIPT_SWEEP_SUMMARY_INTERVAL_MS);
  }

  /** The line to log for this pass, or `null` to stay quiet. */
  record(pass: ReceiptSweepPass, nowMs: number): string | null {
    if (this.debug) {
      return pass.deleted > 0
        ? `[runtime journal] receipt sweep cycle removed ${pass.deleted} stale producer receipts`
        : null;
    }
    this.windowStartedAt ??= nowMs;
    if (pass.deleted > 0) {
      this.deleted += pass.deleted;
      this.cycles += 1;
    }
    if (this.deleted === 0) {
      this.windowStartedAt = nowMs;
      return null;
    }
    if (nowMs - this.windowStartedAt < this.summaryIntervalMs) return null;
    const minutes = Math.max(1, Math.round((nowMs - this.windowStartedAt) / 60_000));
    const line = `[runtime journal] receipt sweep removed ${this.deleted} stale producer receipts across ${this.cycles} cycles in the last ${minutes}m`;
    this.deleted = 0;
    this.cycles = 0;
    this.windowStartedAt = nowMs;
    return line;
  }
}
