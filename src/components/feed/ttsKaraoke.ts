"use client";

/**
 * Follows the voice through the RENDERED message (issue #1022 addendum).
 *
 * The text that is spoken is not the text that is displayed: `spokenAnswerText`
 * drops code blocks, URLs and table bodies and unwraps links, so a character
 * offset in the spoken string means nothing to the markdown React already put
 * on screen. This module aligns the two by their words — the spoken string is
 * essentially a subsequence of the rendered one — and hands back DOM ranges.
 * Nothing here re-parses or rewrites the message: the highlight is painted with
 * the CSS Custom Highlight API over the existing nodes, and the mapping is read
 * back the other way to turn a click into a position in the audio.
 */

const HIGHLIGHT_NAME = "tts-karaoke";
/** Words are matched, not characters: single letters match anywhere. */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
/** How far ahead in the rendered text a spoken word may look for its place. */
const LOOKAHEAD_WORDS = 400;
/** Rendered subtrees the spoken text never contains. */
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "PRE", "CODE", "TEXTAREA"]);

interface Word {
  start: number;
  end: number;
  key: string;
}

interface Flattened {
  text: string;
  nodes: Text[];
  /** Offset of each node's first character in `text`. */
  offsets: number[];
}

export interface KaraokeMap {
  spoken: string;
  /** DOM range covering a spoken character range, or null when unmapped. */
  rangeFor: (startChar: number, endChar: number) => { start: [Text, number]; end: [Text, number] } | null;
  /** The spoken character a rendered DOM point stands for, or null. */
  charAtDomPoint: (node: Node, offset: number) => number | null;
}

function words(text: string): Word[] {
  const found: Word[] = [];
  WORD_RE.lastIndex = 0;
  for (let match = WORD_RE.exec(text); match; match = WORD_RE.exec(text)) {
    found.push({ start: match.index, end: match.index + match[0].length, key: match[0].toLowerCase() });
  }
  return found;
}

function flatten(roots: readonly Element[]): Flattened {
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const value = (node as Text).data;
      if (!value) return;
      nodes.push(node as Text);
      offsets.push(text.length);
      text += value;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (SKIPPED_TAGS.has(element.tagName) || element.getAttribute("aria-hidden") === "true") return;
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  for (const root of roots) visit(root);
  return { text, nodes, offsets };
}

/**
 * The node and offset holding character `index` of the flattened text. On a
 * node boundary `preferEnd` keeps the position at the end of the node that
 * closes, so a highlight ends inside the word it covers instead of at offset 0
 * of whatever follows.
 */
function locate(flat: Flattened, index: number, preferEnd = false): [Text, number] | null {
  if (!flat.nodes.length) return null;
  let low = 0;
  let high = flat.nodes.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (flat.offsets[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  if (preferEnd && low > 0 && flat.offsets[low]! === index) low -= 1;
  const node = flat.nodes[low]!;
  return [node, Math.max(0, Math.min(index - flat.offsets[low]!, node.data.length))];
}

/** DOCUMENT_POSITION_FOLLOWING, without depending on a global `Node`. */
const FOLLOWING = 4;

/**
 * Where a rendered DOM point sits in the flattened text. A point inside a
 * subtree the flattening skipped (a code block) resolves to the first mapped
 * character after it, so a click on code still seeks to the nearest words the
 * voice actually reads.
 */
function flatOffsetOf(flat: Flattened, node: Node, offset: number): number {
  const nodeIndex = flat.nodes.indexOf(node as Text);
  if (nodeIndex >= 0) return flat.offsets[nodeIndex]! + offset;
  for (let index = 0; index < flat.nodes.length; index += 1) {
    if (node.contains(flat.nodes[index]!)) return flat.offsets[index]!;
  }
  for (let index = 0; index < flat.nodes.length; index += 1) {
    if (node.compareDocumentPosition(flat.nodes[index]!) & FOLLOWING) return flat.offsets[index]!;
  }
  return flat.text.length;
}

/**
 * Aligns the spoken words onto the rendered ones. A match is confirmed by the
 * word after it where possible, so a common word ("the", "and") cannot drag the
 * cursor to the wrong place; where the spoken text skipped something the
 * rendered text still shows, the nearest forward occurrence wins.
 */
export function buildKaraokeMap(roots: readonly Element[], spoken: string): KaraokeMap | null {
  const flat = flatten(roots);
  const spokenWords = words(spoken);
  const domWords = words(flat.text);
  if (!spokenWords.length || !domWords.length) return null;

  const spokenToDom = new Array<number>(spokenWords.length).fill(-1);
  const domToSpoken = new Map<number, number>();
  let cursor = 0;
  let matched = 0;
  for (let index = 0; index < spokenWords.length; index += 1) {
    const key = spokenWords[index]!.key;
    const next = spokenWords[index + 1]?.key;
    const limit = Math.min(domWords.length, cursor + LOOKAHEAD_WORDS);
    let nearest = -1;
    let confirmed = -1;
    for (let probe = cursor; probe < limit; probe += 1) {
      if (domWords[probe]!.key !== key) continue;
      if (nearest < 0) nearest = probe;
      if (!next || domWords[probe + 1]?.key === next) { confirmed = probe; break; }
    }
    const at = confirmed >= 0 ? confirmed : nearest;
    if (at < 0) continue;
    spokenToDom[index] = at;
    domToSpoken.set(at, index);
    cursor = at + 1;
    matched += 1;
  }
  if (matched === 0) return null;

  /* The word a rendered offset points at: the one it lands inside, otherwise
     the one about to be read — a click in the gap after a word, or on a code
     block the voice skips, means "carry on from here". */
  const domWordAt = (offset: number): number => {
    let low = 0;
    let high = domWords.length - 1;
    let best = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (domWords[middle]!.start > offset) high = middle - 1;
      else { best = middle; low = middle + 1; }
    }
    if (best < 0) return 0;
    if (domWords[best]!.end > offset) return best;
    return Math.min(best + 1, domWords.length - 1);
  };

  return {
    spoken,
    rangeFor(startChar, endChar) {
      let first = -1;
      let last = -1;
      for (let index = 0; index < spokenWords.length; index += 1) {
        const word = spokenWords[index]!;
        if (word.end <= startChar || word.start >= endChar) continue;
        if (spokenToDom[index]! < 0) continue;
        if (first < 0) first = spokenToDom[index]!;
        last = spokenToDom[index]!;
      }
      if (first < 0) return null;
      const start = locate(flat, domWords[first]!.start);
      const end = locate(flat, domWords[last]!.end, true);
      return start && end ? { start, end } : null;
    },
    charAtDomPoint(node, offset) {
      const flatOffset = flatOffsetOf(flat, node, offset);
      if (flatOffset < 0) return null;
      const at = domWordAt(flatOffset);
      /* The clicked word may be one the voice never says (inline code, a URL):
         walk outward to the nearest word that is spoken. */
      for (let step = 0; step < LOOKAHEAD_WORDS; step += 1) {
        for (const probe of [at + step, at - step]) {
          const spokenIndex = domToSpoken.get(probe);
          if (spokenIndex !== undefined) return spokenWords[spokenIndex]!.start;
        }
      }
      return null;
    },
  };
}

export interface Karaoke {
  /** Paints the spoken character range over the rendered message. */
  highlight: (startChar: number, endChar: number) => void;
  clear: () => void;
  /** Turns a viewport point into a spoken character, for click-to-seek. */
  charAtPoint: (x: number, y: number) => number | null;
  destroy: () => void;
}

interface CaretHost {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => { startContainer: Node; startOffset: number } | null;
}

/**
 * The rendered bodies covered by one Speak control: the message it sits on,
 * plus the follow-on blocks of the SAME answer, which carry no control of their
 * own. `data-tts-message` holds that answer's identity (engine and timestamp,
 * the pair `speakableAnswer` groups on), and the walk stops the moment it
 * changes — carrying no control is not the same as belonging to this answer. A
 * neighbouring answer whose whole content is code or a bare URL renders no
 * control either, and highlighting or seeking inside it would be a lie.
 */
export function karaokeRoots(trigger: Element): HTMLElement[] {
  const message = trigger.closest("[data-tts-message]");
  const own = message?.querySelector<HTMLElement>("[data-tts-body]");
  if (!own) return [];
  const roots = [own];
  const answer = message!.getAttribute("data-tts-message");
  if (!answer) return roots;
  let wrapper = message!.closest('[data-feed-kind="prose"]')?.nextElementSibling ?? null;
  while (wrapper?.getAttribute("data-feed-kind") === "prose") {
    const nextMessage = wrapper.querySelector<HTMLElement>("[data-tts-message]");
    if (nextMessage?.getAttribute("data-tts-message") !== answer) break;
    const body = nextMessage.querySelector<HTMLElement>("[data-tts-body]");
    if (body) roots.push(body);
    wrapper = wrapper.nextElementSibling;
  }
  return roots;
}

export function createKaraoke(roots: readonly Element[], spoken: string): Karaoke | null {
  const map = buildKaraokeMap(roots, spoken);
  if (!map) return null;
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  const paint = registry && typeof Highlight === "function" ? new Highlight() : null;
  if (paint && registry) registry.set(HIGHLIGHT_NAME, paint);

  const clear = () => {
    paint?.clear();
  };
  return {
    highlight(startChar, endChar) {
      if (!paint) return;
      const span = map.rangeFor(startChar, endChar);
      paint.clear();
      if (!span) return;
      const range = document.createRange();
      range.setStart(span.start[0], span.start[1]);
      range.setEnd(span.end[0], span.end[1]);
      paint.add(range);
    },
    clear,
    charAtPoint(x, y) {
      const host = document as unknown as CaretHost;
      const position = host.caretPositionFromPoint?.(x, y);
      if (position) return map.charAtDomPoint(position.offsetNode, position.offset);
      const range = host.caretRangeFromPoint?.(x, y);
      if (range) return map.charAtDomPoint(range.startContainer, range.startOffset);
      return null;
    },
    destroy() {
      clear();
      registry?.delete(HIGHLIGHT_NAME);
    },
  };
}
