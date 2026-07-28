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
 * so a `question` or `confirmation_request` can be answered unambiguously without
 * turning the whole channel into a wire format.
 */

const DIRECTIVE_TOKEN = /^[A-Za-z0-9_.:-]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** Anchored at the end: the trailer is the last line or it is prose. */
const TRAILER = /^\[bridge ref=(\d+)(?: nonce=([A-Za-z0-9_-]+) sha=([0-9a-f]{40}))?\]$/;

export interface BridgeTrailer {
  /** The report `seq` this directive answers. */
  ref: number;
  nonce?: string;
  sha?: string;
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

/** Render the correlation trailer. A confirmation needs the nonce and the SHA
    together — half of one authorizes nothing, and emitting half would produce a
    trailer the manager reads as a bare reference. */
export function formatBridgeTrailer(trailer: BridgeTrailer): string {
  if (!Number.isInteger(trailer.ref) || trailer.ref < 1) {
    throw new Error("a bridge trailer requires the report seq it answers");
  }
  const hasNonce = typeof trailer.nonce === "string" && trailer.nonce.length > 0;
  const hasSha = typeof trailer.sha === "string" && trailer.sha.length > 0;
  if (hasNonce !== hasSha) {
    throw new Error("a bridge confirmation trailer requires nonce and sha together");
  }
  if (!hasNonce) return `[bridge ref=${trailer.ref}]`;
  if (!FULL_SHA.test(trailer.sha!)) {
    throw new Error("a bridge confirmation trailer requires a full lowercase 40-hex commit SHA");
  }
  return `[bridge ref=${trailer.ref} nonce=${trailer.nonce} sha=${trailer.sha}]`;
}

/**
 * Read the trailer off the end of a directive body, or null.
 *
 * Last non-empty line only. Scanning the whole body would let the manager's own
 * quoted text — a report the gateway is repeating back, say — be mistaken for an
 * authorization, which is the one place in this design where being generous
 * about input would let a deploy through.
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
  return match[2] && match[3]
    ? { ref, nonce: match[2], sha: match[3] }
    : { ref };
}

/** Compose the message the gateway sends: the user's intent in words, then the
    trailer on its own line when one is needed. */
export function bridgeDirectiveBody(instruction: string, trailer?: BridgeTrailer): string {
  const text = instruction.trim();
  if (!trailer) return text;
  return `${text}\n\n${formatBridgeTrailer(trailer)}`;
}
