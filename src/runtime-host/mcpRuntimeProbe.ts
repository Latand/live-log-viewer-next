import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { MCP_HEALTH_PROBE_CAPABILITY_ENV } from "@/lib/mcp/healthProbeAdmission";
import { MCP_TOOL_NAMES } from "@/lib/mcp/server";
import { redactMonitorText } from "@/lib/monitor/redact";
import type {
  ViewerMcpRuntimeCallFailure,
  ViewerMcpRuntimeHealthEvidence,
  ViewerMcpRuntimeIdentity,
} from "@/lib/runtime/contracts";

import { probeExcerpt } from "./deploymentHealth";
import { McpProbeStdioTransport } from "./mcpProbeStdioTransport";
import type { McpHealthProbeAdmissionConsumer } from "./mcpHealthProbeAdmissionChannel";

/* The probe gate is the tool surface this generation ships; a duplicated list
   silently stops gating whenever a tool is added. */
const REQUIRED_TOOLS: readonly string[] = MCP_TOOL_NAMES;

export interface McpRuntimeProbeOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  runtime: ViewerMcpRuntimeIdentity;
  healthProbeCapability?: string;
  healthProbeAdmissions?: McpHealthProbeAdmissionConsumer;
  timeoutMs?: number;
  onProcessReady?: (pid: number) => void;
}

function successfulToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as { isError?: unknown; structuredContent?: unknown };
  if (result.isError === true || !result.structuredContent || typeof result.structuredContent !== "object") return false;
  return (result.structuredContent as { ok?: unknown }).ok === true;
}

/** What the candidate's own MCP said when a read was refused. `deploymentStatus
    false` with nothing beside it cost a whole deploy cycle to interpret in
    #790, and the refusal already carries the status and the reason. */
export function mcpToolCallRefusal(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "no result";
  const result = value as { structuredContent?: unknown; content?: unknown };
  const structured = result.structuredContent && typeof result.structuredContent === "object"
    ? (result.structuredContent as { error?: unknown; status?: unknown })
    : null;
  const error = typeof structured?.error === "string" ? structured.error : null;
  const text = Array.isArray(result.content)
    ? (result.content as Array<{ type?: unknown; text?: unknown }>)
      .find((entry) => entry?.type === "text" && typeof entry.text === "string")?.text as string | undefined
    : undefined;
  const reason = error ?? text ?? "refused without a reason";
  /* The refusal usually spells the status out already; a second copy of it
     reads like two different failures. */
  const status = typeof structured?.status === "number" && !reason.includes(String(structured.status))
    ? ` (status ${structured.status})`
    : "";
  return `${reason}${status}`;
}

/** The MCP failure envelope's own code (`tool_failed`, `tool_not_permitted`,
    `call_interrupted`, …), which classes a refusal without parsing its prose. */
export function mcpToolCallRefusalCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return null;
  const code = (structured as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 64) : null;
}

/* How much of a refusal the durable record keeps. The record outlives the
   candidate and the operator pastes it into issues, so the text is redacted,
   collapsed to one printable line and clamped where it is captured, exactly
   like `containerLog`. Redaction runs before the clamp so a truncation can
   never leave half of what it removed. */
const CALL_FAILURE_CHARS = 300;

function recordedRefusal(value: unknown): string {
  return probeExcerpt(redactMonitorText(mcpToolCallRefusal(value)), CALL_FAILURE_CHARS);
}

/** The failing reads, each with the tool's own account of why it failed.
    `calls` already says WHICH read failed, and that boolean was the entire
    record for three deploys — it can explain none of them (#790). Empty when
    every read answered. */
export function mcpProbeCallFailures(
  calls: Array<{ name: string; ok: boolean; result: unknown }>,
): ViewerMcpRuntimeCallFailure[] {
  return calls
    .filter((call) => !call.ok)
    .map((call) => {
      const code = mcpToolCallRefusalCode(call.result);
      return {
        tool: call.name,
        ...(code ? { code } : {}),
        error: recordedRefusal(call.result),
      };
    });
}

/** Names the failed read, its refusal and the control surface the probe was
    pointed at, so a failure can be told apart from a probe aimed at the wrong
    Viewer without re-reading the adapter (#790). */
export function mcpProbeFailureDetail(input: {
  controlUrl: string | undefined;
  calls: Array<{ name: string; ok: boolean; result: unknown }>;
}): string {
  const failures = mcpProbeCallFailures(input.calls)
    .map((failure) => `${failure.tool}: ${failure.error}`);
  const target = input.controlUrl ? ` against ${input.controlUrl}` : "";
  return `MCP runtime read probes failed${target} - ${failures.join("; ") || "no read reported a reason"}`
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

export const VIEWER_CONTROL_URL_ENV = "LLV_VIEWER_CONTROL_URL";

/** The control endpoint the probed runtime must read through. Absent or blank,
    the MCP server falls back to the fixed loopback address, which belongs to the
    Viewer that is already serving — so the probe would grade the running
    generation and pass or fail it on behalf of the runtime under test (#790).
    Callers get the trimmed endpoint back, or `null` to refuse on. */
export function probeControlUrl(value: string | undefined): string | null {
  const url = value?.trim() ?? "";
  return /^https?:\/\/[^\s]+$/.test(url) ? url : null;
}

export async function probeMcpRuntime(options: McpRuntimeProbeOptions): Promise<ViewerMcpRuntimeHealthEvidence> {
  const checkedAt = new Date().toISOString();
  const timeout = Math.max(1, options.timeoutMs ?? 15_000);
  const controlUrl = probeControlUrl(options.env[VIEWER_CONTROL_URL_ENV]);
  /* Refusing before anything is spawned: a probe that cannot name its own
     target must never address another one instead. */
  if (!controlUrl) {
    return {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady: false,
      tools: [],
      calls: { deploymentStatus: false, boardSnapshot: false },
      ok: false,
      detail: `MCP runtime probe requires ${VIEWER_CONTROL_URL_ENV}: without the probed runtime's own control endpoint`
        + " its reads resolve to the Viewer already serving instead of the one under test",
    };
  }
  const environment = { ...options.env };
  delete environment[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  if (options.healthProbeCapability) {
    environment[MCP_HEALTH_PROBE_CAPABILITY_ENV] = options.healthProbeCapability;
  }
  const transport = new McpProbeStdioTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: environment,
    ...(options.healthProbeAdmissions ? { healthAdmissions: options.healthProbeAdmissions } : {}),
  });
  const client = new Client({ name: "viewer-deployment-mcp-probe", version: "1.0.0" });
  let processReady = false;
  let tools: string[] = [];
  let deploymentStatus = false;
  let boardSnapshot = false;
  try {
    await client.connect(transport);
    processReady = true;
    if (transport.pid !== null) options.onProcessReady?.(transport.pid);
    const listed = await client.listTools(undefined, { timeout });
    tools = listed.tools.map((tool) => tool.name).sort();
    const requestId = randomUUID();
    const deployment = await client.callTool({
      name: "deployment_status",
      arguments: { clientRequestId: `deployment-probe-${requestId}`, limit: 1 },
    }, undefined, { timeout });
    deploymentStatus = successfulToolCall(deployment);
    const board = await client.callTool({
      name: "board_snapshot",
      arguments: { clientRequestId: `board-probe-${requestId}`, limit: 1 },
    }, undefined, { timeout });
    boardSnapshot = successfulToolCall(board);
    const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    const ok = missing.length === 0 && deploymentStatus && boardSnapshot;
    const reads = [
      { name: "deployment_status", ok: deploymentStatus, result: deployment },
      { name: "board_snapshot", ok: boardSnapshot, result: board },
    ];
    /* Kept whenever a read was refused, including when a missing tool decides
       the verdict: the refusal is the only account of the candidate's own
       runtime that survives, and the candidate is retired seconds later. */
    const callFailures = mcpProbeCallFailures(reads);
    return {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady,
      tools,
      calls: { deploymentStatus, boardSnapshot },
      ...(callFailures.length ? { callFailures } : {}),
      ok,
      ...(ok ? {} : {
        detail: missing.length
          ? `MCP runtime is missing tools: ${missing.join(", ")}`
          : mcpProbeFailureDetail({ controlUrl, calls: reads }),
      }),
    };
  } catch (error) {
    return {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady,
      tools,
      calls: { deploymentStatus, boardSnapshot },
      ok: false,
      detail: (error instanceof Error ? error.message : "MCP runtime probe failed").replace(/[\r\n]+/g, " ").slice(0, 500),
    };
  } finally {
    await client.close().catch(() => transport.close().catch(() => {}));
  }
}
