import type { FileEntry } from "@/lib/types";

export interface LegacySchedulerPorts {
  scan(): Promise<FileEntry[]>;
  tickFlows(entries: FileEntry[]): Promise<unknown>;
  tickWorkflows(entries: FileEntry[]): Promise<unknown>;
  tickTaskInbox(entries: FileEntry[]): void;
  publishFiles?(entries: FileEntry[]): Promise<void> | void;
}

/** Bounded legacy reconciliation while structured runtime ownership is disabled. */
export class LegacyRuntimeScheduler {
  private lastRun = 0;
  private running = false;

  constructor(private readonly ports: LegacySchedulerPorts, private readonly cadenceMs = 15_000, private readonly now = () => Date.now()) {}

  async runDue(): Promise<boolean> {
    if (this.running || this.now() - this.lastRun < this.cadenceMs) return false;
    this.running = true;
    try {
      const entries = await this.ports.scan();
      await this.ports.publishFiles?.(entries);
      await this.ports.tickFlows(entries);
      await this.ports.tickWorkflows(entries);
      this.ports.tickTaskInbox(entries);
      this.lastRun = this.now();
      return true;
    } finally {
      this.running = false;
    }
  }
}
