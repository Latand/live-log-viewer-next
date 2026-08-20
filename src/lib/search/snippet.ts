/*
 * Match markers inside an FTS5 snippet.
 *
 * `snippet()` wraps every matched term in a delimiter pair chosen by the
 * caller. The index stores raw message bodies, so any PRINTABLE delimiter also
 * occurs inside those bodies: with the original `[` / `]` pair a snippet cut
 * from a code fragment highlighted every bracket the operator ever typed. These
 * two control characters cannot appear in a transcript body, so splitting on
 * them is exact.
 *
 * Pure and dependency-free on purpose: the SQL query surface, the route and the
 * browser renderer all read the same two constants, and the client bundle must
 * not pull `bun:sqlite` in to learn them.
 */
export const SNIPPET_MATCH_OPEN = "\u0001";
export const SNIPPET_MATCH_CLOSE = "\u0002";

export interface SnippetSegment {
  text: string;
  /** A term the query matched — rendered highlighted. */
  match: boolean;
}

/**
 * Splits a delimited snippet into rendering segments. Every marker is consumed,
 * so no sentinel can ever reach the DOM, and unbalanced or absent markers
 * degrade to plain text instead of swallowing the snippet.
 */
export function snippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let text = "";
  let match = false;
  for (const char of snippet) {
    if (char !== SNIPPET_MATCH_OPEN && char !== SNIPPET_MATCH_CLOSE) {
      text += char;
      continue;
    }
    if (text) segments.push({ text, match });
    text = "";
    match = char === SNIPPET_MATCH_OPEN;
  }
  if (text) segments.push({ text, match });
  return segments;
}
