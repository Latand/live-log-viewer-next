import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { RuntimeEvent } from "./engineHost";

export interface RuntimeEventStore {
  load(threadId: string): RuntimeEvent[];
  append(threadId: string, event: RuntimeEvent): void;
}

function validEvent(value: unknown): value is RuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RuntimeEvent>;
  return Number.isSafeInteger(event.seq) && event.seq! > 0 && typeof event.kind === "string";
}

export class FileRuntimeEventStore implements RuntimeEventStore {
  constructor(private readonly directory = statePath("structured-host-events")) {}

  load(threadId: string): RuntimeEvent[] {
    const filename = this.filename(threadId);
    let contents: string;
    try { contents = fs.readFileSync(filename, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: RuntimeEvent[] = [];
    for (const line of contents.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!validEvent(parsed)) continue;
      const previous = events.at(-1);
      if (previous && parsed.seq <= previous.seq) continue;
      events.push(parsed);
    }
    return events;
  }

  append(threadId: string, event: RuntimeEvent): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.filename(threadId), "a+", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) fs.writeSync(fd, "\n");
      }
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private filename(threadId: string): string {
    return path.join(this.directory, `${encodeURIComponent(threadId)}.jsonl`);
  }
}
