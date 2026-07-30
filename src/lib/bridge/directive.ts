/**
 * The root → manager direction (§4).
 *
 * Directives are ordinary MCP `send_message` calls, which is the whole trick:
 * `send_message` is already durable-receipt tooling, so a replayed
 * `clientRequestId` returns the original receipt instead of delivering twice.
 * Exactly-once is a property the bridge inherits rather than one it implements —
 * provided ids are *derived* and never minted fresh on retry (§7.1).
 *
 * The body is plain instruction text, because the manager is a language model
 * reading a message, not a parser. Correlation rides in one optional trailer line
 * so a `question` can be answered unambiguously without turning the whole channel
 * into a wire format. The trailer carries a report reference and nothing else:
 * it correlates, it never authorizes.
 */

const DIRECTIVE_TOKEN = /^[A-Za-z0-9_.:-]+$/;
/** Anchored at the end: the trailer is the last line or it is prose. */
const TRAILER = /^\[bridge ref=(\d+)\]$/;

export interface BridgeTrailer {
  /** The report `seq` this directive answers. */
  ref: number;
}

/**
 * The `clientRequestId` for one directive: derived from the root turn that
 * produced it and the utterance index within that turn.
 *
 * Never a clock and never a random id. A retry after a lost receipt has to
 * present the *same* id or the durable receipt cannot recognize it, and the
 * manager gets the instruction twice.
 */
export function bridgeDirectiveId(rootTurnId: string, utterance: number): string {
  if (!DIRECTIVE_TOKEN.test(rootTurnId)) {
    throw new Error("a bridge directive id requires a root turn id of [A-Za-z0-9_.:-]+");
  }
  if (!Number.isInteger(utterance) || utterance < 0) {
    throw new Error("a bridge directive id requires a non-negative integer utterance index");
  }
  return `bridge_d_${rootTurnId}_${utterance}`;
}

/** Render the correlation trailer. */
export function formatBridgeTrailer(trailer: BridgeTrailer): string {
  if (!Number.isInteger(trailer.ref) || trailer.ref < 1) {
    throw new Error("a bridge trailer requires the report seq it answers");
  }
  return `[bridge ref=${trailer.ref}]`;
}

/**
 * Read the trailer off the end of a directive body, or null.
 *
 * Last non-empty line only. Scanning the whole body would let the manager's own
 * quoted text — a report the gateway is repeating back, say — be mistaken for an
 * answer to a different report.
 */
export function parseBridgeTrailer(body: string): BridgeTrailer | null {
  const lines = body.split(/\r?\n/);
  let last = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line) {
      last = line;
      break;
    }
  }
  const match = TRAILER.exec(last);
  if (!match) return null;
  const ref = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(ref) || ref < 1) return null;
  return { ref };
}

/** Compose the message the gateway sends: the user's intent in words, then the
    trailer on its own line when one is needed. */
export function bridgeDirectiveBody(instruction: string, trailer?: BridgeTrailer): string {
  const text = instruction.trim();
  if (!trailer) return text;
  return `${text}\n\n${formatBridgeTrailer(trailer)}`;
}
