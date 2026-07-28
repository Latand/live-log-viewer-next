import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import { PassThrough, type Stream } from "node:stream";

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  createMcpHealthProbeAdmissionChannel,
  serveMcpHealthProbeAdmissionChannel,
  type McpHealthProbeAdmissionConsumer,
} from "./mcpHealthProbeAdmissionChannel";

export interface McpProbeStdioParameters {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  healthAdmissions?: McpHealthProbeAdmissionConsumer;
}

/**
 * MCP stdio transport with one reserved descriptor inherited from the
 * host-owned probe chain. Launch environment and JSON input cannot select or
 * redirect descriptor 3.
 */
export class McpProbeStdioTransport implements Transport {
  private child?: ChildProcess;
  private closeHealthAdmission?: () => void;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream = new PassThrough();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(private readonly parameters: McpProbeStdioParameters) {}

  get stderr(): Stream {
    return this.stderrStream;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("MCP probe transport already started");
    const admissionChannel = this.parameters.healthAdmissions
      ? await createMcpHealthProbeAdmissionChannel()
      : null;
    await new Promise<void>((resolve, reject) => {
      const healthAdmission = admissionChannel?.childFd ?? "ignore";
      const stdio: StdioOptions = ["pipe", "pipe", "pipe", healthAdmission];
      const spawnOptions: SpawnOptions = {
        cwd: this.parameters.cwd,
        env: { ...getDefaultEnvironment(), ...this.parameters.env } as NodeJS.ProcessEnv,
        stdio,
        shell: false,
        windowsHide: process.platform === "win32",
      };
      let child: ChildProcess;
      try {
        child = spawn(this.parameters.command, this.parameters.args, spawnOptions);
      } catch (error) {
        admissionChannel?.close();
        throw error;
      } finally {
        admissionChannel?.closeChildFd();
      }
      this.child = child;
      if (this.parameters.healthAdmissions && admissionChannel) {
        const closeServing = serveMcpHealthProbeAdmissionChannel(
          admissionChannel.channel,
          this.parameters.healthAdmissions,
        );
        this.closeHealthAdmission = () => {
          closeServing();
          admissionChannel.close();
        };
      }
      child.once("error", (error) => {
        this.closeHealthAdmission?.();
        this.closeHealthAdmission = undefined;
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", resolve);
      child.once("close", () => {
        this.closeHealthAdmission?.();
        this.closeHealthAdmission = undefined;
        this.child = undefined;
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stderr?.pipe(this.stderrStream);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child) {
      this.child = undefined;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try { child.stdin?.end(); } catch { /* already closed */ }
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
      if (child.exitCode === null) {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
      }
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }
    this.closeHealthAdmission?.();
    this.closeHealthAdmission = undefined;
    this.readBuffer.clear();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error("MCP probe transport is not connected");
    const serialized = serializeMessage(message);
    if (stdin.write(serialized)) return;
    await new Promise<void>((resolve) => stdin.once("drain", resolve));
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
