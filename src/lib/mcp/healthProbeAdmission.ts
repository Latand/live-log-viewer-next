import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";

export const MCP_HEALTH_PROBE_CAPABILITY_ENV = "LLV_MCP_HEALTH_PROBE_CAPABILITY";

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
type HealthAdmissionClient = Pick<RuntimeHostClient, "admitMcpHealthProbe">;

/**
 * Redeem a runtime-host-minted health capability. The environment value is
 * only a carrier: a missing client, malformed/self-selected value, host
 * rejection, or transport failure all resolve to ordinary fail-closed policy.
 */
export async function admittedMcpHealthProbe(
  capability: unknown,
  client?: HealthAdmissionClient | null,
): Promise<boolean> {
  if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) return false;
  const host = client === undefined ? runtimeHostClient() : client;
  if (!host?.admitMcpHealthProbe) return false;
  try {
    return await host.admitMcpHealthProbe(capability);
  } catch {
    return false;
  }
}
