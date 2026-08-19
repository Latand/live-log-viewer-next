import {
  decodeSelectedContextRef,
  encodeSelectedContextRef,
  type SelectedContextRef,
} from "@/lib/selection/selectedContext";

/**
 * The marker line that makes a Codex app-server user record recognisably OURS.
 *
 * It is one HTML comment on the record's first line, carrying named attributes:
 * `sha256` (the structured content digest, when images make the echo lossy) and
 * `ctx` (the selected-card reference, #844). Both are optional and independent,
 * and the two older forms — bare marker, and marker with only a digest — decode
 * byte-identically to what they always did. Transcripts are not migrated.
 *
 * Attributes are `name=value` whose values may hold anything but a space and a
 * `>`, so the marker cannot be broken open by its own payload and stays on one
 * line. The grammar is deliberately looser than what we WRITE: a corrupt or
 * forged attribute value must cost only that attribute, never the record's
 * structured-user identity, which is what routes it to the user lane. The
 * operator's own text may legitimately begin with something marker-shaped, so
 * the prefix is only ever stripped once, from the front.
 */

const STRUCTURED_USER_MARKER = "<!-- llv:structured-user -->\n";
const MARKER_WITH_ATTRIBUTES = /^<!-- llv:structured-user((?: [a-z0-9]+=[^ >]+)+) -->\n/;
const ATTRIBUTE = /(?:^| )([a-z0-9]+)=([^ >]+)/g;
const SHA256 = /^[a-f0-9]{64}$/;

export interface DecodedCodexStructuredUserText {
  text: string;
  structured: boolean;
  contentDigest: string | null;
  /** The selected-card reference this turn was admitted with, or null. A
      corrupt or forged value decodes as null: the record still reads. */
  selectedContext: SelectedContextRef | null;
  /** Hash-only identity minted after server-side operator authorization. */
  operatorActionKey?: string;
}

export function encodeCodexStructuredUserText(
  text: string,
  contentDigest?: string,
  selectedContext?: SelectedContextRef | null,
  operatorActionKey?: string,
): string {
  const attributes: string[] = [];
  if (contentDigest) attributes.push(`sha256=${contentDigest}`);
  if (selectedContext) attributes.push(`ctx=${encodeSelectedContextRef(selectedContext)}`);
  if (operatorActionKey && SHA256.test(operatorActionKey)) attributes.push(`op=${operatorActionKey}`);
  if (attributes.length === 0) return STRUCTURED_USER_MARKER + text;
  return `<!-- llv:structured-user ${attributes.join(" ")} -->\n${text}`;
}

export function decodeCodexStructuredUserText(value: string): DecodedCodexStructuredUserText {
  const marker = value.match(MARKER_WITH_ATTRIBUTES);
  if (marker) {
    let contentDigest: string | null = null;
    let selectedContext: SelectedContextRef | null = null;
    let operatorActionKey: string | undefined;
    for (const [, name, attribute] of marker[1]!.matchAll(ATTRIBUTE)) {
      if (name === "sha256" && SHA256.test(attribute!)) contentDigest = attribute!;
      if (name === "ctx") selectedContext = decodeSelectedContextRef(attribute!);
      if (name === "op" && SHA256.test(attribute!)) operatorActionKey = attribute!;
    }
    return {
      text: value.slice(marker[0].length),
      structured: true,
      contentDigest,
      selectedContext,
      ...(operatorActionKey ? { operatorActionKey } : {}),
    };
  }
  if (!value.startsWith(STRUCTURED_USER_MARKER)) {
    return { text: value, structured: false, contentDigest: null, selectedContext: null };
  }
  return {
    text: value.slice(STRUCTURED_USER_MARKER.length),
    structured: true,
    contentDigest: null,
    selectedContext: null,
  };
}
