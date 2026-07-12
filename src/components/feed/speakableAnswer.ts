import { spokenAnswerText } from "@/lib/tts";

import type { FeedEntry } from "./parse";

function sameAnswer(a: FeedEntry["item"], b: FeedEntry["item"]): boolean {
  return a.kind === "prose" && b.kind === "prose" && a.engine === b.engine && String(a.ts) === String(b.ts);
}

export function speakableAnswer(entries: FeedEntry[], index: number): { text: string; firstIndex: number; lastIndex: number } | null {
  const selected = entries[index]?.item;
  if (selected?.kind !== "prose") return null;
  let firstIndex = index;
  let lastIndex = index;
  while (firstIndex > 0 && sameAnswer(entries[firstIndex - 1]!.item, selected)) firstIndex -= 1;
  while (lastIndex + 1 < entries.length && sameAnswer(entries[lastIndex + 1]!.item, selected)) lastIndex += 1;
  const text = spokenAnswerText(
    entries.slice(firstIndex, lastIndex + 1).map((entry) => entry.item.kind === "prose" ? entry.item.text : "").join("\n\n"),
  );
  return text ? { text, firstIndex, lastIndex } : null;
}
