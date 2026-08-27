import { NATIVE_MULTI_AGENT_TOOLS } from "@/lib/agent/spawnPolicy";

import { STRUCTURED_IMAGE_CAPABILITY } from "./structuredContent";

/**
 * What a structured host's `activeFlags` actually say.
 *
 * The channel carries two unrelated kinds of statement and the name only
 * describes one of them:
 *
 * - **Capability advertisements** — durable launch evidence. Every Claude host
 *   advertises {@link STRUCTURED_IMAGE_CAPABILITY} for its whole life, and one
 *   launched with the native multi-agent denial also advertises the effective
 *   denied-tool set (#381) so a registry snapshot can verify the restriction
 *   without the argv. Both are true of an idle host and of a busy one.
 * - **Activity flags** — something the host is doing right now.
 *
 * Automatic retirement (#747) reads this channel for the second kind. Reading
 * the raw array instead makes the clause vacuous in the direction that matters:
 * every Claude host carries a capability advertisement forever, so a predicate
 * that refuses on a non-empty array refuses every Claude host forever and
 * retires nothing at all — which is the population #747 exists for.
 *
 * The classification is a closed list on purpose. An advertisement a later
 * release adds is invisible here until it is named, so it blocks retirement
 * until then: an unrecognised flag is treated as activity, and treating an
 * unknown as idle is the mistake this whole predicate exists to avoid.
 */

/** Durable launch evidence: hosts that launched with the native multi-agent
    denial advertise the effective denied-tool set so registry snapshots and
    incident review (#381) can verify the restriction without the argv. */
export const NATIVE_MULTI_AGENT_DENY_FLAG = `native-multi-agent-deny:${NATIVE_MULTI_AGENT_TOOLS.join(",")}`;

/** Advertisements whose whole value is the exact string. */
const CAPABILITY_FLAGS: ReadonlySet<string> = new Set([STRUCTURED_IMAGE_CAPABILITY]);

/** Advertisements that carry a payload after a colon — the denied-tool set is
    the argv-free record of the restriction, so it changes with the tool list
    and cannot be matched exactly. */
const CAPABILITY_FLAG_PREFIXES: readonly string[] = ["native-multi-agent-deny:"];

/** True when this flag describes what the host CAN do rather than what it IS
    doing. Everything else counts as activity. */
export function isHostCapabilityFlag(flag: string): boolean {
  return CAPABILITY_FLAGS.has(flag)
    || CAPABILITY_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix));
}

/** The flags that say this host is busy, with the advertisements removed. */
export function blockingHostActivityFlags(flags: readonly string[]): string[] {
  return flags.filter((flag) => !isHostCapabilityFlag(flag));
}
