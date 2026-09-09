/**
 * The forms of one message text a durable delivery record can be holding (#1609).
 *
 * The send route normalizes before it reserves. Structured admission is handed
 * `payloadText.trim()` (`api/conversation-host/handlers.ts`), so the reservation
 * and its `contentDigest` carry the trimmed text and never the caller's trailing
 * newline; the legacy path on that same route reserves the text verbatim. A
 * reader that still holds the ORIGINAL arguments — original-key send recovery is
 * the one that matters, because it answers whether an accepted send executed —
 * therefore has to ask which of those forms was stored, instead of comparing its
 * raw argument against one of them and reporting the difference as a conflict.
 *
 * Surrounding whitespace is the WHOLE of the normalization: any other difference
 * is a genuine payload conflict and stays one. The feed's occurrence join reads
 * the same two forms for the same reason (`components/feed/deliveredOccurrences.ts`);
 * it digests in the browser through a Node-free SHA-256, which is why the two
 * do not share one function.
 */
export function admittedMessageTextForms(text: string): readonly string[] {
  const trimmed = text.trim();
  return trimmed === text ? [text] : [trimmed, text];
}
