import crypto from "node:crypto";

import { processTelegramAdapter, type TelegramAdapter, type TelegramEnrollmentHandle } from "./adapter";
import { ensureTelegramConnector, stopTelegramConnector, type ConnectorEnsureResult } from "./connector";
import type { TelegramErrorCode, TelegramIdentity, TelegramStatusPayload } from "./contracts";
import { registerTelegramHosts, unregisterTelegramHosts } from "./hostRegistration";
import {
  deleteTelegramSession,
  readTelegramConnection,
  readTelegramSession,
  saveTelegramSession,
  writeTelegramConnection,
  UnsafeTelegramSessionError,
  type StoredTelegramConnection,
} from "./sessionStore";

/**
 * The one Telegram connection service (issue #1059), mirroring the
 * account-login operation pattern: at most one login operation at a time,
 * explicit phases, sanitized failures, and cancellation that terminates the
 * enrollment process and clears its temporary state.
 *
 * The session string is touched in exactly two places: the `authorized` event
 * handler (pipe → owner-only store) and reads that immediately hand it to the
 * adapter or connector env. It never enters the status payload this service
 * projects.
 */

export interface TelegramServicePorts {
  adapter: TelegramAdapter;
  ensureConnector(sessionString: string): Promise<ConnectorEnsureResult>;
  stopConnector(): void;
  registerHosts(): void;
  unregisterHosts(): void;
  now(): number;
}

const productionPorts: TelegramServicePorts = {
  adapter: processTelegramAdapter,
  ensureConnector: (sessionString) => ensureTelegramConnector(sessionString),
  stopConnector: stopTelegramConnector,
  registerHosts: () => registerTelegramHosts(),
  unregisterHosts: () => unregisterTelegramHosts(),
  now: Date.now,
};

type LiveLogin = {
  operationId: string;
  phase: "starting" | "awaiting_scan" | "awaiting_password" | "verifying";
  qr: { url: string; expiresAt: string } | null;
  passwordError: boolean;
  handle: TelegramEnrollmentHandle;
};

export class TelegramConnectionService {
  private login: LiveLogin | null = null;
  private healthInFlight: Promise<void> | null = null;

  constructor(private readonly ports: TelegramServicePorts = productionPorts) {}

  status(): TelegramStatusPayload {
    if (this.login) {
      return {
        phase: this.login.phase,
        login: {
          operationId: this.login.operationId,
          qr: this.login.phase === "awaiting_scan" ? this.login.qr : null,
          passwordError: this.login.passwordError,
        },
        identity: null,
        credentialRef: null,
        lastHealthCheckAt: null,
        error: null,
      };
    }
    let connection: StoredTelegramConnection;
    try {
      connection = readTelegramConnection();
    } catch (error) {
      if (!(error instanceof UnsafeTelegramSessionError)) throw error;
      return this.payloadFor({ version: 1, status: "error", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: "session_unsafe" });
    }
    return this.payloadFor(connection);
  }

  private payloadFor(connection: StoredTelegramConnection): TelegramStatusPayload {
    return {
      phase: connection.status,
      login: null,
      identity: connection.identity,
      credentialRef: connection.credentialRef,
      lastHealthCheckAt: connection.lastHealthCheckAt,
      error: connection.status === "error" && connection.errorCode ? { code: connection.errorCode } : null,
    };
  }

  /** Starts the QR login. One operation at a time — a second start while one
      is live is refused, exactly like the account-login supervisor. */
  startLogin(): TelegramStatusPayload {
    if (this.login) throw new Error("a Telegram login operation is already running");
    const unavailable = this.ports.adapter.unavailableReason();
    if (unavailable) {
      this.recordError(unavailable);
      return this.status();
    }
    const operationId = crypto.randomUUID();
    const handle = this.ports.adapter.startEnrollment((event) => {
      const current = this.login;
      if (!current || current.operationId !== operationId) return;
      switch (event.type) {
        case "qr":
          current.phase = "awaiting_scan";
          current.qr = { url: event.url, expiresAt: event.expiresAt };
          return;
        case "password_required":
          current.phase = "awaiting_password";
          current.qr = null;
          return;
        case "password_invalid":
          current.phase = "awaiting_password";
          current.passwordError = true;
          return;
        case "verifying":
          current.phase = "verifying";
          current.qr = null;
          return;
        case "authorized":
          /* The operation stays live (as "verifying") until the connector's
             read-only surface is verified — connected is never published on
             the authorization alone. */
          current.phase = "verifying";
          current.qr = null;
          void this.completeEnrollment(event.sessionString, event.identity);
          return;
        case "failed":
          this.login = null;
          if (event.code !== "canceled") this.recordError(event.code);
          return;
      }
    });
    this.login = { operationId, phase: "starting", qr: null, passwordError: false, handle };
    return this.status();
  }

  /** Persist → verify → publish, in that order: the credential is saved first
      (Telegram authorized it; losing it would force a rescan), then the
      shared connector must come up AND pass the read-only verification before
      the connection reads as connected or any host registration happens.
      EVERY failure — refusal, timeout, thrown error — lands in an explicit
      error state over the preserved session. A cancel racing this tail does
      not undo it: the account authorized, so the outcome is reported. */
  private async completeEnrollment(sessionString: string, identity: TelegramIdentity): Promise<void> {
    let credentialRef: string;
    try {
      credentialRef = saveTelegramSession(sessionString).credentialRef;
    } catch {
      this.login = null;
      this.recordError("session_unsafe");
      return;
    }
    let connector: Awaited<ReturnType<TelegramServicePorts["ensureConnector"]>>;
    try {
      connector = await this.ports.ensureConnector(sessionString);
    } catch {
      connector = { ok: false, code: "connector_failed" };
    }
    this.login = null;
    if (!connector.ok) {
      writeTelegramConnection({ version: 1, status: "error", credentialRef, identity, lastHealthCheckAt: null, errorCode: connector.code });
      return;
    }
    writeTelegramConnection({
      version: 1,
      status: "connected",
      credentialRef,
      identity,
      lastHealthCheckAt: new Date(this.ports.now()).toISOString(),
      errorCode: null,
    });
    this.ports.registerHosts();
  }

  private recordError(code: TelegramErrorCode): void {
    const connection = this.safeConnection();
    /* A failed RE-connect over a still-stored session keeps that session and
       its identity; only the status and code change. */
    writeTelegramConnection({ ...connection, status: "error", errorCode: code });
  }

  private safeConnection(): StoredTelegramConnection {
    try {
      return readTelegramConnection();
    } catch {
      return { version: 1, status: "disconnected", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: null };
    }
  }

  submitPassword(operationId: string, password: string): TelegramStatusPayload {
    const current = this.login;
    if (!current || current.operationId !== operationId) throw new Error("Telegram login operation is unavailable");
    if (current.phase !== "awaiting_password") throw new Error("Telegram login is not awaiting a password");
    if (typeof password !== "string" || password.length === 0 || password.length > 4096) throw new Error("Telegram password is invalid");
    current.phase = "verifying";
    current.passwordError = false;
    current.handle.submitPassword(password);
    return this.status();
  }

  /** Terminates the enrollment process and clears temporary login state. The
      stored connection (a previous session, if any) is untouched. */
  cancelLogin(operationId: string): TelegramStatusPayload {
    const current = this.login;
    if (current && current.operationId === operationId) {
      this.login = null;
      current.handle.cancel();
    }
    return this.status();
  }

  /** Health check against the stored session; updates the durable status. */
  async checkHealth(): Promise<TelegramStatusPayload> {
    if (this.login) return this.status();
    if (!this.healthInFlight) {
      this.healthInFlight = this.runHealthCheck().finally(() => { this.healthInFlight = null; });
    }
    await this.healthInFlight;
    return this.status();
  }

  private async runHealthCheck(): Promise<void> {
    let session: ReturnType<typeof readTelegramSession>;
    try {
      session = readTelegramSession();
    } catch (error) {
      if (!(error instanceof UnsafeTelegramSessionError)) throw error;
      this.recordError("session_unsafe");
      return;
    }
    const connection = this.safeConnection();
    if (!session) {
      if (connection.status !== "disconnected") {
        writeTelegramConnection({ version: 1, status: "disconnected", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: null });
      }
      return;
    }
    const result = await this.ports.adapter.checkSession(session.sessionString);
    const checkedAt = new Date(this.ports.now()).toISOString();
    if (result.status === "connected") {
      /* A healthy account only reads as connected once the shared connector
         also stands verified — the same gate enrollment applies. A failure
         here keeps the session (the account is fine) and surfaces the code;
         the next fresh health check retries without a rescan. */
      let connector: Awaited<ReturnType<TelegramServicePorts["ensureConnector"]>>;
      try {
        connector = await this.ports.ensureConnector(session.sessionString);
      } catch {
        connector = { ok: false, code: "connector_failed" };
      }
      if (!connector.ok) {
        writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: result.identity, lastHealthCheckAt: checkedAt, errorCode: connector.code });
        return;
      }
      writeTelegramConnection({ version: 1, status: "connected", credentialRef: session.credentialRef, identity: result.identity, lastHealthCheckAt: checkedAt, errorCode: null });
      return;
    }
    if (result.status === "expired") {
      writeTelegramConnection({ version: 1, status: "expired", credentialRef: session.credentialRef, identity: connection.identity, lastHealthCheckAt: checkedAt, errorCode: null });
      this.ports.stopConnector();
      return;
    }
    writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: connection.identity, lastHealthCheckAt: checkedAt, errorCode: result.code });
  }

  /** Remote logout. Success removes the local session too; failure PRESERVES
      the local session (the operator can retry or fall back to local-only
      deletion) and reports why. */
  async logout(): Promise<TelegramStatusPayload> {
    if (this.login) throw new Error("a Telegram login operation is running");
    const session = this.readSessionOrNull();
    if (!session) {
      this.disconnectLocally();
      return this.status();
    }
    const result = await this.ports.adapter.logout(session.sessionString);
    if (!result.ok) {
      this.recordError(result.code ?? "logout_failed");
      return this.status();
    }
    this.disconnectLocally();
    return this.status();
  }

  /** Local-only deletion: removes the credential and stops the connector. The
      remote Telegram authorization may remain — the UI says so. */
  deleteLocalSession(): TelegramStatusPayload {
    if (this.login) throw new Error("a Telegram login operation is running");
    this.disconnectLocally();
    return this.status();
  }

  private readSessionOrNull(): ReturnType<typeof readTelegramSession> {
    try {
      return readTelegramSession();
    } catch {
      return null;
    }
  }

  private disconnectLocally(): void {
    deleteTelegramSession();
    writeTelegramConnection({ version: 1, status: "disconnected", credentialRef: null, identity: null, lastHealthCheckAt: null, errorCode: null });
    this.ports.stopConnector();
    this.ports.unregisterHosts();
  }
}

/* One service per process, across route bundles. */
const SERVICE_KEY = "__llvTelegramService" as const;

export function telegramService(): TelegramConnectionService {
  const holder = globalThis as typeof globalThis & { [SERVICE_KEY]?: TelegramConnectionService };
  holder[SERVICE_KEY] ??= new TelegramConnectionService();
  return holder[SERVICE_KEY];
}

export function setTelegramServiceForTests(service: TelegramConnectionService | null): void {
  const holder = globalThis as typeof globalThis & { [SERVICE_KEY]?: TelegramConnectionService };
  if (service) holder[SERVICE_KEY] = service;
  else delete holder[SERVICE_KEY];
}
