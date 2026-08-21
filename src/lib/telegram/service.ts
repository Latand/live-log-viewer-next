import crypto from "node:crypto";

import { processTelegramAdapter, type TelegramAdapter, type TelegramEnrollmentEvent, type TelegramEnrollmentHandle } from "./adapter";
import { ensureTelegramConnector, stopTelegramConnector, type ConnectorEnsureResult } from "./connector";
import type { TelegramErrorCode, TelegramIdentity, TelegramStatusPayload } from "./contracts";
import { registerTelegramHosts, unregisterTelegramHosts, type TelegramHostRegistrationResult } from "./hostRegistration";
import { telegramApiCredentials } from "./packaging";
import {
  deleteTelegramSession,
  readTelegramConnection,
  readTelegramSession,
  saveTelegramSession,
  writeTelegramConnection,
  UnsafeTelegramSessionError,
  type StoredTelegramConnection,
  type StoredTelegramSession,
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
  ensureConnector(session: StoredTelegramSession): Promise<ConnectorEnsureResult>;
  stopConnector(): Promise<void> | void;
  registerHosts(): TelegramHostRegistrationResult;
  unregisterHosts(): void;
  now(): number;
  /** Whether host API credentials exist (env or telegram.json) — surfaced to
      the browser as a boolean only (#1070). */
  credentialsConfigured(): boolean;
}

const productionPorts: TelegramServicePorts = {
  adapter: processTelegramAdapter,
  ensureConnector: (session) => ensureTelegramConnector(session),
  stopConnector: stopTelegramConnector,
  registerHosts: () => registerTelegramHosts(),
  unregisterHosts: () => unregisterTelegramHosts(),
  now: Date.now,
  credentialsConfigured: () => telegramApiCredentials() !== null,
};

type LiveLogin = {
  operationId: string;
  generation: number;
  phase: "starting" | "awaiting_scan" | "awaiting_password" | "verifying";
  qr: { url: string; expiresAt: string } | null;
  passwordError: boolean;
  handle: TelegramEnrollmentHandle;
  stored: StoredTelegramSession | null;
};

type LifecycleJob = {
  generation: number;
  skip(): void;
  run(generation: number): Promise<void>;
};

export class TelegramConnectionService {
  private login: LiveLogin | null = null;
  private lifecycleGeneration = 0;
  private lifecycleActive = false;
  private readonly lifecycleQueue: LifecycleJob[] = [];

  constructor(private readonly ports: TelegramServicePorts = productionPorts) {}

  /** The single mutation chokepoint. Destructive jobs advance the generation
      when enqueued; queued events carrying an older generation are
      discarded before they can touch connector, host, credential, or status
      state. The queue holds across awaits, so lifecycle side effects never
      interleave. */
  private enqueueLifecycle<T>(
    operation: (generation: number) => Promise<T> | T,
    options: { supersede?: boolean; expectedGeneration?: number; stale?: () => T } = {},
  ): Promise<T> {
    const generation = options.supersede
      ? ++this.lifecycleGeneration
      : options.expectedGeneration ?? this.lifecycleGeneration;
    return new Promise<T>((resolve, reject) => {
      this.lifecycleQueue.push({
        generation,
        skip: () => {
          try { resolve((options.stale ?? (() => this.status() as T))()); }
          catch (error) { reject(error); }
        },
        run: async (generation) => {
          try { resolve(await operation(generation)); }
          catch (error) { reject(error); }
        },
      });
      void this.drainLifecycleQueue();
    });
  }

  private async drainLifecycleQueue(): Promise<void> {
    if (this.lifecycleActive) return;
    this.lifecycleActive = true;
    try {
      while (this.lifecycleQueue.length > 0) {
        const job = this.lifecycleQueue.shift()!;
        if (job.generation !== this.lifecycleGeneration) {
          job.skip();
          continue;
        }
        await job.run(job.generation);
      }
    } finally {
      this.lifecycleActive = false;
      if (this.lifecycleQueue.length > 0) void this.drainLifecycleQueue();
    }
  }

  private lifecycleIsCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration;
  }

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
        credentialsConfigured: this.ports.credentialsConfigured(),
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
      credentialsConfigured: this.ports.credentialsConfigured(),
    };
  }

  /** Starts the QR login. One operation at a time — a second start while one
      is live is refused, exactly like the account-login supervisor. */
  startLogin(): Promise<TelegramStatusPayload> {
    return this.enqueueLifecycle((generation) => this.startLoginLocked(generation));
  }

  private startLoginLocked(generation: number): TelegramStatusPayload {
    if (this.login) throw new Error("a Telegram login operation is already running");
    const unavailable = this.ports.adapter.unavailableReason();
    if (unavailable) {
      this.recordError(unavailable);
      return this.status();
    }
    const operationId = crypto.randomUUID();
    const handle = this.ports.adapter.startEnrollment((event) => {
      void this.enqueueLifecycle(
        (eventGeneration) => this.applyEnrollmentEvent(operationId, event, eventGeneration),
        { expectedGeneration: generation, stale: () => undefined },
      );
    });
    this.login = { operationId, generation, phase: "starting", qr: null, passwordError: false, handle, stored: null };
    return this.status();
  }

  private async applyEnrollmentEvent(operationId: string, event: TelegramEnrollmentEvent, generation: number): Promise<void> {
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
        current.phase = "verifying";
        current.qr = null;
        await this.completeEnrollment(current, event.sessionString, event.identity, generation);
        return;
      case "failed":
        this.login = null;
        await this.cleanupCanceledLogin(current);
        if (event.code !== "canceled") this.recordError(event.code);
        return;
    }
  }

  /** Persist → verify → publish, in that order: the credential is saved first
      (Telegram authorized it; losing it would force a rescan), then the
      shared connector must come up AND pass the read-only verification before
      the connection reads as connected or any host registration happens.
      EVERY failure — refusal, timeout, thrown error — lands in an explicit
      error state over the preserved session. Cancellation invalidates the
      generation and removes a credential that authorization already wrote. */
  private async completeEnrollment(operation: LiveLogin, sessionString: string, identity: TelegramIdentity, generation: number): Promise<void> {
    let stored: StoredTelegramSession;
    try {
      stored = saveTelegramSession(sessionString);
      operation.stored = stored;
    } catch {
      this.login = null;
      this.recordError("session_unsafe");
      return;
    }
    let connector: Awaited<ReturnType<TelegramServicePorts["ensureConnector"]>>;
    try {
      connector = await this.ports.ensureConnector(stored);
    } catch {
      connector = { ok: false, code: "connector_failed" };
    }
    if (!this.lifecycleIsCurrent(generation) || this.login !== operation) return;
    this.login = null;
    if (!connector.ok) {
      writeTelegramConnection({ version: 1, status: "error", credentialRef: stored.credentialRef, identity, lastHealthCheckAt: null, errorCode: connector.code });
      return;
    }
    if (!this.registerVerifiedHosts()) {
      await this.cleanupFailedRegistration();
      writeTelegramConnection({ version: 1, status: "error", credentialRef: stored.credentialRef, identity, lastHealthCheckAt: null, errorCode: "host_registration_failed" });
      return;
    }
    writeTelegramConnection({
      version: 1,
      status: "connected",
      credentialRef: stored.credentialRef,
      identity,
      lastHealthCheckAt: new Date(this.ports.now()).toISOString(),
      errorCode: null,
    });
  }

  private registerVerifiedHosts(): boolean {
    try { return this.ports.registerHosts().ok; }
    catch { return false; }
  }

  private async cleanupFailedRegistration(): Promise<void> {
    await this.teardownConnectorAndHosts();
  }

  private async teardownConnectorAndHosts(): Promise<boolean> {
    let connectorStopped = true;
    try { await this.ports.stopConnector(); }
    catch { connectorStopped = false; }
    try { this.ports.unregisterHosts(); } catch { /* continue credential cleanup */ }
    return connectorStopped;
  }

  private deleteCredentialsAndPublishDisconnected(connectorStopped = true): void {
    let deleted = false;
    try {
      deleteTelegramSession();
      deleted = true;
    } catch { /* unsafe credential remains explicit below */ }
    try {
      if (deleted) {
        writeTelegramConnection({
          version: 1,
          status: connectorStopped ? "disconnected" : "error",
          credentialRef: null,
          identity: null,
          lastHealthCheckAt: null,
          errorCode: connectorStopped ? null : "connector_failed",
        });
      } else {
        this.recordError("session_unsafe");
      }
    } catch { /* durable status cleanup was still attempted independently */ }
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

  submitPassword(operationId: string, password: string): Promise<TelegramStatusPayload> {
    const expectedGeneration = this.login?.generation;
    return this.enqueueLifecycle(
      () => this.submitPasswordLocked(operationId, password),
      { expectedGeneration, stale: () => this.status() },
    );
  }

  private submitPasswordLocked(operationId: string, password: string): TelegramStatusPayload {
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
  cancelLogin(operationId: string): Promise<TelegramStatusPayload> {
    const supersede = this.login?.operationId === operationId;
    return this.enqueueLifecycle(() => this.cancelLoginLocked(operationId), { supersede });
  }

  private async cancelLoginLocked(operationId: string): Promise<TelegramStatusPayload> {
    const current = this.login;
    if (current && current.operationId === operationId) {
      this.login = null;
      current.handle.cancel();
      await this.cleanupCanceledLogin(current);
    }
    return this.status();
  }

  private async cleanupCanceledLogin(operation: LiveLogin): Promise<void> {
    if (!operation.stored) return;
    const connectorStopped = await this.teardownConnectorAndHosts();
    try {
      const current = readTelegramSession();
      if (current && current.credentialRef !== operation.stored.credentialRef) return;
    } catch { /* still attempt the safe deletion boundary */ }
    this.deleteCredentialsAndPublishDisconnected(connectorStopped);
  }

  /** Health check against the stored session; updates the durable status. */
  checkHealth(): Promise<TelegramStatusPayload> {
    const expectedGeneration = this.lifecycleGeneration;
    return this.enqueueLifecycle(async (generation) => {
      if (this.login) return this.status();
      await this.runHealthCheck(generation);
      return this.status();
    }, { expectedGeneration, stale: () => this.status() });
  }

  private async runHealthCheck(generation: number): Promise<void> {
    let session: ReturnType<typeof readTelegramSession>;
    try {
      session = readTelegramSession();
    } catch (error) {
      if (!(error instanceof UnsafeTelegramSessionError)) throw error;
      await this.teardownConnectorAndHosts();
      this.recordError("session_unsafe");
      return;
    }
    const connection = this.safeConnection();
    if (!session) {
      const connectorStopped = await this.teardownConnectorAndHosts();
      if (!connectorStopped || connection.status !== "disconnected") {
        writeTelegramConnection({
          version: 1,
          status: connectorStopped ? "disconnected" : "error",
          credentialRef: null,
          identity: null,
          lastHealthCheckAt: null,
          errorCode: connectorStopped ? null : "connector_failed",
        });
      }
      return;
    }
    /* The bridge uses the same StringSession as the shared connector. Release
       the long-lived owner before the short health client acquires the
       vendored per-session lock and connects. */
    try { await this.ports.stopConnector(); }
    catch {
      this.recordError("connector_failed");
      return;
    }
    const result = await this.ports.adapter.checkSession(session.sessionString);
    if (!this.lifecycleIsCurrent(generation)) return;
    const checkedAt = new Date(this.ports.now()).toISOString();
    if (result.status === "connected") {
      /* A healthy account only reads as connected once the shared connector
         also stands verified — the same gate enrollment applies. A failure
         here keeps the session (the account is fine) and surfaces the code;
         the next fresh health check retries without a rescan. */
      let connector: Awaited<ReturnType<TelegramServicePorts["ensureConnector"]>>;
      try {
        connector = await this.ports.ensureConnector(session);
      } catch {
        connector = { ok: false, code: "connector_failed" };
      }
      if (!this.lifecycleIsCurrent(generation)) return;
      if (!connector.ok) {
        writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: result.identity, lastHealthCheckAt: checkedAt, errorCode: connector.code });
        return;
      }
      if (!this.registerVerifiedHosts()) {
        await this.cleanupFailedRegistration();
        writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: result.identity, lastHealthCheckAt: checkedAt, errorCode: "host_registration_failed" });
        return;
      }
      writeTelegramConnection({ version: 1, status: "connected", credentialRef: session.credentialRef, identity: result.identity, lastHealthCheckAt: checkedAt, errorCode: null });
      return;
    }
    if (result.status === "expired") {
      writeTelegramConnection({ version: 1, status: "expired", credentialRef: session.credentialRef, identity: connection.identity, lastHealthCheckAt: checkedAt, errorCode: null });
      return;
    }
    writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: connection.identity, lastHealthCheckAt: checkedAt, errorCode: result.code });
  }

  /** Remote logout. Success removes the local session too; failure PRESERVES
      the local session (the operator can retry or fall back to local-only
      deletion) and reports why. */
  logout(): Promise<TelegramStatusPayload> {
    return this.enqueueLifecycle((generation) => this.logoutLocked(generation), { supersede: this.login === null });
  }

  private async logoutLocked(generation: number): Promise<TelegramStatusPayload> {
    if (this.login) throw new Error("a Telegram login operation is running");
    let session: ReturnType<typeof readTelegramSession>;
    try {
      session = readTelegramSession();
    } catch (error) {
      if (!(error instanceof UnsafeTelegramSessionError)) throw error;
      await this.teardownConnectorAndHosts();
      this.recordError("session_unsafe");
      return this.status();
    }
    if (!session) {
      await this.disconnectLocally();
      return this.status();
    }
    /* Remote revocation uses a short-lived client with this exact session.
       Release the shared connector first; the bridge's session lock then
       waits for process exit before it contacts Telegram. */
    try { await this.ports.stopConnector(); }
    catch {
      this.recordError("connector_failed");
      return this.status();
    }
    const result = await this.ports.adapter.logout(session.sessionString);
    if (!this.lifecycleIsCurrent(generation)) return this.status();
    if (!result.ok) {
      this.recordError(result.code ?? "logout_failed");
      return this.status();
    }
    /* The terminal transition runs the complete teardown even though logout
       already stopped the connector before the bridge call. */
    await this.disconnectLocally();
    return this.status();
  }

  /** Local-only deletion: removes the credential and stops the connector. The
      remote Telegram authorization may remain — the UI says so. */
  deleteLocalSession(): Promise<TelegramStatusPayload> {
    return this.enqueueLifecycle(() => this.deleteLocalSessionLocked(), { supersede: this.login === null });
  }

  private async deleteLocalSessionLocked(): Promise<TelegramStatusPayload> {
    if (this.login) throw new Error("a Telegram login operation is running");
    await this.disconnectLocally();
    return this.status();
  }

  private async disconnectLocally(): Promise<void> {
    const connectorStopped = await this.teardownConnectorAndHosts();
    this.deleteCredentialsAndPublishDisconnected(connectorStopped);
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
