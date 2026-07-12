import { homedir } from "node:os";

export type Sequenced<T> = { seq: number; value: T };

export class ReplayBuffer<T> {
  readonly #limit: number;
  #nextSeq = 1;
  #items: Sequenced<T>[] = [];

  constructor(limit = 2_000) {
    this.#limit = limit;
  }

  push(value: T): Sequenced<T> {
    const item = { seq: this.#nextSeq++, value };
    this.#items.push(item);
    if (this.#items.length > this.#limit) this.#items.shift();
    return item;
  }

  after(seq: number): Sequenced<T>[] {
    return this.#items.filter((item) => item.seq > seq);
  }

  get lastSeq(): number {
    return this.#nextSeq - 1;
  }
}

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]{20,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,}\]]+/gi,
];

export function sanitize<T>(value: T): T {
  if (typeof value === "string") {
    let result = value.replaceAll(homedir(), "$HOME");
    result = result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
    for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, "[REDACTED_TOKEN]");
    return result as T;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitize(item)]),
    ) as T;
  }
  return value;
}

export class EvidenceLog {
  #records: unknown[] = [];

  record(source: string, event: string, data: unknown = {}): void {
    const row = sanitize({ at: new Date().toISOString(), source, event, data });
    this.#records.push(row);
    console.log(JSON.stringify(row));
  }

  async write(path: string): Promise<void> {
    const text = `${this.#records.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await Bun.write(path, text);
  }
}

export function subscriptionEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

export function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readLines(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();
  return text.split("\n").filter(Boolean);
}
