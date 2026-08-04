/*
 * The artifact preview's own URL fragment (issue #884): `#a=<encoded path>`,
 * parallel to — and deliberately distinct from — the `#f=` conversation card
 * deep-link. The fragment carries ONLY the path. Everything that decides
 * whether the path may be read stays where a clicked link already goes:
 * classification in ./classify.ts and authorization in /api/artifact — so a
 * pasted URL can never reach a file a click could not.
 */

export function formatArtifactFragment(path: string): string {
  return "#a=" + encodeURIComponent(path);
}

/** The linked path an `#a=` fragment names, or null for every other fragment.
    Malformed percent-encoding degrades to the raw payload (matching the
    conversation hash parser) — the server rejects nonsense paths explicitly. */
export function parseArtifactFragment(hash: string): string | null {
  const match = hash.match(/^#a=(.+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}
