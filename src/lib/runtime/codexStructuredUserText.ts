const STRUCTURED_USER_MARKER = "<!-- llv:structured-user -->\n";
const STRUCTURED_USER_DIGEST = /^<!-- llv:structured-user sha256=([a-f0-9]{64}) -->\n/;

export function encodeCodexStructuredUserText(text: string, contentDigest?: string): string {
  if (contentDigest) return `<!-- llv:structured-user sha256=${contentDigest} -->\n${text}`;
  return STRUCTURED_USER_MARKER + text;
}

export function decodeCodexStructuredUserText(value: string): { text: string; structured: boolean; contentDigest: string | null } {
  const digest = value.match(STRUCTURED_USER_DIGEST);
  if (digest) return { text: value.slice(digest[0].length), structured: true, contentDigest: digest[1]! };
  if (!value.startsWith(STRUCTURED_USER_MARKER)) return { text: value, structured: false, contentDigest: null };
  return { text: value.slice(STRUCTURED_USER_MARKER.length), structured: true, contentDigest: null };
}
