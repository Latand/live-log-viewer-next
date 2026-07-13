import type { ConversationCatalogEntry } from "./conversationCatalog";
import { cleanTitle } from "@/lib/title";

import { searchTextForTranscript } from "./describe";

type TranscriptSearchText = ReturnType<typeof searchTextForTranscript>;
type SearchTextReader = (pathname: string, size: number, engine: "codex" | "claude") => TranscriptSearchText;
type YieldControl = () => Promise<void>;

interface SearchTextCacheEntry extends TranscriptSearchText {
  size: number;
}

const BATCH_SIZE = 24;
const store = globalThis as typeof globalThis & {
  __llvConversationSearchText?: Map<string, SearchTextCacheEntry>;
  __llvConversationSearchQueue?: Promise<void>;
};

function eventLoopYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function buildIndex(
  catalog: readonly ConversationCatalogEntry[],
  readText: SearchTextReader,
  yieldControl: YieldControl,
  batchSize: number,
): Promise<ConversationCatalogEntry[]> {
  const cache = store.__llvConversationSearchText ??= new Map();
  const indexed: ConversationCatalogEntry[] = [];
  for (let index = 0; index < catalog.length; index += 1) {
    const entry = catalog[index];
    let text = cache.get(entry.path);
    if (!text || text.size !== entry.size) {
      text = { ...readText(entry.path, entry.size, entry.engine), size: entry.size };
      cache.set(entry.path, text);
    }
    indexed.push({
      ...entry,
      title: entry.kind === "session" && text.title ? cleanTitle(text.title, 120) : entry.title,
      firstPrompt: text.firstPrompt ?? "",
    });
    if ((index + 1) % batchSize === 0) await yieldControl();
  }
  return indexed;
}

/** Builds the uncapped search projection in small event-loop batches. The
 * scheme scanner never calls this path, and repeated searches reuse transcript
 * head text until a file's size changes. */
export async function indexConversationCatalog(
  catalog: readonly ConversationCatalogEntry[],
  options: { readText?: SearchTextReader; yieldControl?: YieldControl; batchSize?: number } = {},
): Promise<ConversationCatalogEntry[]> {
  const readText = options.readText ?? searchTextForTranscript;
  const yieldControl = options.yieldControl ?? eventLoopYield;
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  if (options.readText || options.yieldControl || options.batchSize) {
    return buildIndex(catalog, readText, yieldControl, batchSize);
  }

  const previous = store.__llvConversationSearchQueue ?? Promise.resolve();
  let release!: () => void;
  store.__llvConversationSearchQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await buildIndex(catalog, readText, yieldControl, batchSize);
  } finally {
    release();
  }
}
