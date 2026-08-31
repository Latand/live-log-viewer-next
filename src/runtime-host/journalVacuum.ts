import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

export const RUNTIME_JOURNAL_VACUUM_MIN_FREE_BYTES = 64 * 1_024 * 1_024;
export const RUNTIME_JOURNAL_VACUUM_MIN_FREE_RATIO = 0.25;
export const RUNTIME_JOURNAL_VACUUM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface RuntimeJournalFreelist {
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  autoVacuum: number;
  lastVacuumAt: number | null;
}

function pragmaNumber(database: Database, name: string): number {
  const row = database.query<Record<string, number>, []>(`PRAGMA ${name}`).get();
  return Number(row?.[name] ?? 0);
}

function freelist(database: Database): RuntimeJournalFreelist {
  let lastVacuumAt: number | null = null;
  try {
    const raw = database.query<{ value: string }, []>(
      "SELECT value FROM journal_meta WHERE key = 'last_vacuum_at'",
    ).get()?.value;
    const parsed = Number(raw);
    if (raw !== undefined && Number.isSafeInteger(parsed) && parsed >= 0) lastVacuumAt = parsed;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no such table: journal_meta")) throw error;
    /* A pre-journal fixture has no metadata table and therefore no prior run. */
  }
  return {
    pageSize: pragmaNumber(database, "page_size"),
    pageCount: pragmaNumber(database, "page_count"),
    freelistPages: pragmaNumber(database, "freelist_count"),
    autoVacuum: pragmaNumber(database, "auto_vacuum"),
    lastVacuumAt,
  };
}

export function inspectRuntimeJournalFreelist(filename: string): RuntimeJournalFreelist {
  const database = new Database(filename, { readonly: true, strict: true });
  try {
    return freelist(database);
  } finally {
    database.close();
  }
}

/** Rebuild only when empty pages are both material (64 MiB) and dominant
    (25%), at most daily. This keeps ordinary churn on SQLite's reuse path and
    admits the incident journal whose freelist held 90.5% of a 1.98 GB file. */
export function runtimeJournalVacuumDue(status: RuntimeJournalFreelist, now = Date.now()): boolean {
  const freeBytes = status.pageSize * status.freelistPages;
  const freeRatio = status.pageCount > 0 ? status.freelistPages / status.pageCount : 0;
  const intervalElapsed = status.lastVacuumAt === null
    || now - status.lastVacuumAt >= RUNTIME_JOURNAL_VACUUM_MIN_INTERVAL_MS;
  return freeBytes >= RUNTIME_JOURNAL_VACUUM_MIN_FREE_BYTES
    && freeRatio >= RUNTIME_JOURNAL_VACUUM_MIN_FREE_RATIO
    && intervalElapsed;
}

/** Run outside the runtime-host process. VACUUM uses a synchronous SQLite
    interface, so the host launches this module under bun-container and keeps
    serving socket requests while the rebuild copies live pages. A passive WAL
    checkpoint precedes it; a successful rebuild enables incremental vacuum on
    legacy files and truncates the remaining WAL. */
export function vacuumRuntimeJournal(filename: string, completedAt?: number): RuntimeJournalFreelist {
  const database = new Database(filename, { create: false, strict: true });
  try {
    database.exec("PRAGMA busy_timeout = 60000; PRAGMA wal_checkpoint(PASSIVE);");
    database.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
    database.query(`
      INSERT INTO journal_meta(key, value) VALUES ('last_vacuum_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(completedAt ?? Date.now()));
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return freelist(database);
  } finally {
    database.close();
    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
      try { fs.chmodSync(candidate, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export async function spawnRuntimeJournalVacuum(filename: string): Promise<void> {
  const runtime = fs.existsSync("/usr/local/bin/bun-container")
    ? "/usr/local/bin/bun-container"
    : process.execPath;
  const vacuumCommand = [
    runtime,
    "run",
    path.join(import.meta.dir, "journalVacuum.ts"),
    filename,
  ];
  const command = fs.existsSync("/usr/bin/setpriv")
    ? ["/usr/bin/setpriv", "--pdeathsig", "KILL", "--", ...vacuumCommand]
    : vacuumCommand;
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.replace(/\s+/g, " ").trim().slice(0, 400);
    throw new Error(`runtime journal vacuum exited with status ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
}

if (import.meta.main) {
  const filename = process.argv[2];
  if (!filename) throw new Error("runtime journal filename is required");
  vacuumRuntimeJournal(filename);
}
