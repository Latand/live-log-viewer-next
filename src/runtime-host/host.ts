import fs from "node:fs";
import path from "node:path";

import type { RuntimeEventInput, RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

export class RuntimeHostFence {
  private held = false;
  constructor(private readonly filename: string) {}
  acquire(): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(this.filename, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx", mode: 0o600 });
      this.held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("runtime host singleton fence is held");
      throw error;
    }
  }
  release(): void { if (this.held) fs.rmSync(this.filename, { force: true }); this.held = false; }
}

export class RuntimeHost {
  constructor(readonly journal: RuntimeJournal) {}

  handle(request: RuntimeSocketRequest): RuntimeSocketResponse {
    try {
      let result: unknown;
      if (request.method === "snapshot") result = this.journal.snapshot();
      else if (request.method === "events") result = this.journal.replay(Number(request.params?.after ?? 0));
      else if (request.method === "append" || request.method === "operation") {
        const event = request.params?.event as RuntimeEventInput;
        const appended = this.journal.append(event);
        result = request.method === "operation" && event.operationId
          ? { operationId: event.operationId, state: "accepted", seq: appended.seq, revision: appended.revision }
          : appended;
      } else throw new Error("runtime request method is unsupported");
      return { id: request.id, ok: true, result };
    } catch (error) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : "runtime request failed" };
    }
  }
}
