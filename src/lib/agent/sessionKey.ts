import path from "node:path";

import type { AgentEngine } from "./cli";

/** Stable identity for an engine conversation. Mutable host details deliberately
    live elsewhere: a pane, PID, or tmux server can disappear and be replaced. */
export interface SessionKey {
  engine: AgentEngine;
  sessionId: string;
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function normalizeSessionId(value: string): string | null {
  const match = value.match(SESSION_ID)?.[0];
  return match && match.length === value.length ? match.toLowerCase() : null;
}

export function sessionKey(engine: AgentEngine, sessionId: string): SessionKey | null {
  const normalized = normalizeSessionId(sessionId);
  return normalized ? { engine, sessionId: normalized } : null;
}

export function sessionKeyId(key: SessionKey): string {
  return `${key.engine}:${key.sessionId}`;
}

export function sessionKeyFromTranscript(engine: AgentEngine, pathname: string): SessionKey | null {
  const base = path.basename(pathname);
  const match = base.match(SESSION_ID);
  return match ? sessionKey(engine, match[0]) : null;
}

export function sessionKeyFromArgv(engine: AgentEngine, argv: string[]): SessionKey | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const match = argv[index]?.match(SESSION_ID);
    if (match) return sessionKey(engine, match[0]);
  }
  return null;
}
