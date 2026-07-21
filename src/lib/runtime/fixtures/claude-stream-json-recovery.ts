import type { ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

class ClaudeRecoveryFixture extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = process.pid;

  private input = "";
  private deliveryCount = 0;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly deliveryLog: string,
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => this.acceptInput(String(chunk)));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.closed) return false;
    queueMicrotask(() => {
      if (this.closed) return;
      this.closed = true;
      this.stdout.end();
      this.stderr.end();
      this.emit("close", 0, signal);
    });
    return true;
  }

  private acceptInput(chunk: string): void {
    this.input += chunk;
    let newline = this.input.indexOf("\n");
    while (newline >= 0) {
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      if (line) this.acceptFrame(line);
      newline = this.input.indexOf("\n");
    }
  }

  private acceptFrame(line: string): void {
    const frame = record(JSON.parse(line));
    const message = record(frame?.message);
    const content = message?.content;
    if (frame?.type !== "user"
      || frame.session_id !== this.sessionId
      || message?.role !== "user"
      || !Array.isArray(content)) {
      throw new Error("recovery fixture received an invalid user frame");
    }
    const text = content.map((block) => {
      const candidate = record(block);
      return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    }).join("");
    if (!text.trim()) throw new Error("recovery fixture received an empty user frame");
    const deliveryCount = ++this.deliveryCount;
    const textSha256 = crypto.createHash("sha256").update(text).digest("hex");
    fs.appendFileSync(this.deliveryLog, `${JSON.stringify({
      sessionId: this.sessionId,
      deliveryCount,
      textSha256,
    })}\n`);
    queueMicrotask(() => {
      if (this.closed) return;
      this.emitJson({
        type: "user",
        isReplay: true,
        session_id: this.sessionId,
        uuid: `fixture-user-${deliveryCount}`,
        message: { role: "user", content },
      });
      this.emitJson({
        type: "assistant",
        session_id: this.sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "RECOVERY_OK" }] },
      });
      this.emitJson({
        type: "result",
        subtype: "success",
        session_id: this.sessionId,
      });
    });
  }

  private emitJson(value: JsonObject): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

export function spawnClaudeRecoveryFixture(
  sessionId: string,
  deliveryLog: string,
): ChildProcessWithoutNullStreams {
  return new ClaudeRecoveryFixture(sessionId, deliveryLog) as unknown as ChildProcessWithoutNullStreams;
}
