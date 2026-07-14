const STRUCTURED_USER_MARKER = "<!-- llv:structured-user -->\n";

export function encodeCodexStructuredUserText(text: string): string {
  return STRUCTURED_USER_MARKER + text;
}

export function decodeCodexStructuredUserText(value: string): { text: string; structured: boolean } {
  if (!value.startsWith(STRUCTURED_USER_MARKER)) return { text: value, structured: false };
  return { text: value.slice(STRUCTURED_USER_MARKER.length), structured: true };
}
