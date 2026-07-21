import { procBackend } from "@/lib/proc";
import type {
  ViewerDeploymentOwner,
  ViewerDeploymentReceipt,
  ViewerDeploymentRequest,
  ViewerDeploymentStatus,
  ViewerHealthEvidence,
  ViewerReleaseIdentity,
} from "@/lib/runtime/contracts";
import { RuntimeIdempotencyConflictError } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

/** The generation identity the running runtime-host process booted from.
    A `null` revision means the process predates staged generations (the
    legacy fixed-tag image) and can never be proven current. */
export interface RuntimeHostGeneration {
  image: string | null;
  revision: string | null;
}

export interface RuntimeHostHandoffContext {
  deploymentId: string;
  revision: string;
  successor: ViewerReleaseIdentity;
  previous: RuntimeHostGeneration;
}

export interface ViewerDeploymentAdapter {
  /** Durably stages the candidate image as the successor runtime-host
      generation: a dockerd-owned successor container waiting on the singleton
      fence, the service image tag repointed, the release record written, and
      the predecessor's restart policy disabled so the stale image cannot
      restart. Resolves only once the successor observably exists; never
      stops the predecessor and never signals Viewer containers or engine
      hosts — the predecessor's own graceful exit afterwards is the handoff. */
  stageRuntimeHostSuccessor(candidate: ViewerReleaseIdentity): Promise<void>;
  reconcile(): Promise<void>;
  resolveRevision(revision: string): Promise<string>;
  buildCandidate(deploymentId: string, revision: string): Promise<ViewerReleaseIdentity>;
  startCandidate(candidate: ViewerReleaseIdentity): Promise<void>;
  currentRelease(): Promise<ViewerReleaseIdentity | null>;
  verifyCandidate(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence>;
  promote(candidate: ViewerReleaseIdentity): Promise<void>;
  verifyPromoted(candidate: ViewerReleaseIdentity): Promise<ViewerHealthEvidence>;
  rollback(previous: ViewerReleaseIdentity, candidate: ViewerReleaseIdentity): Promise<void>;
  retire(release: ViewerReleaseIdentity): Promise<void>;
  retainOnly(releases: ViewerReleaseIdentity[]): Promise<void>;
}

export interface ViewerDeploymentCoordinatorOptions {
  defaultRevision?: string;
  ownerAlive?: (owner: ViewerDeploymentOwner) => boolean;
  /** The generation this runtime-host process booted from. Production #518:
      the host ran a baked stale image for hours after the fixed sources were
      deployed, because nothing in the exact-SHA contract ever replaced the
      long-lived singleton. Bun loads modules once at boot, so only a
      successor process can execute the deployed revision. */
  hostGeneration?: () => RuntimeHostGeneration;
  /** Observes a staged successor handoff. Invoked only after the terminal
      succeeded deployment AND after the successor staging is durable — never
      as a same-image self-restart, which would boot the stale image again. */
  onHostHandoff?: (context: RuntimeHostHandoffContext) => void;
}

function validRequestedRevision(revision: string): boolean {
  return revision === "origin/main" || /^[0-9a-f]{40}$/.test(revision);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "viewer deployment failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export class ViewerDeploymentCoordinator {
  private readonly tasks = new Map<string, Promise<void>>();
  private admissionQueue: Promise<void> = Promise.resolve();
  private readonly defaultRevision: string;
  private readonly ownerAlive: (owner: ViewerDeploymentOwner) => boolean;
  private readonly hostGeneration?: () => RuntimeHostGeneration;
  private readonly onHostHandoff?: (context: RuntimeHostHandoffContext) => void;

  constructor(
    private readonly journal: RuntimeJournal,
    private readonly adapter: ViewerDeploymentAdapter,
    private readonly owner: ViewerDeploymentOwner,
    options: ViewerDeploymentCoordinatorOptions = {},
  ) {
    this.defaultRevision = options.defaultRevision ?? "origin/main";
    this.ownerAlive = options.ownerAlive ?? ((candidate) =>
      procBackend.pidAlive(candidate.pid)
      && (candidate.startIdentity === null || procBackend.processIdentity(candidate.pid) === candidate.startIdentity));
    this.hostGeneration = options.hostGeneration;
    this.onHostHandoff = options.onHostHandoff;
  }

  async requestViewerDeployment(request: ViewerDeploymentRequest): Promise<ViewerDeploymentReceipt> {
    return this.runAdmissionExclusive(() => this.admit(request));
  }

  private async admit(request: ViewerDeploymentRequest): Promise<ViewerDeploymentReceipt> {
    if (!request.idempotencyKey || request.idempotencyKey.length > 200 || /[\r\n]/.test(request.idempotencyKey)) {
      throw new Error("deployment idempotencyKey is invalid");
    }
    const requestedRevision = request.revision?.trim() || this.defaultRevision;
    if (!validRequestedRevision(requestedRevision)) throw new Error("deployment revision must be origin/main or a full commit SHA");
    const existing = this.journal.viewerDeploymentByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      if (existing.requestedRevision !== requestedRevision) throw new RuntimeIdempotencyConflictError("idempotency key already belongs to another deployment");
      if (!existing.terminal
        && existing.owner.pid === this.owner.pid
        && existing.owner.startIdentity === this.owner.startIdentity) {
        this.start(existing);
      }
      return { state: "accepted", deploymentId: existing.deploymentId, revision: existing.revision, replayed: true };
    }
    const active = this.journal.activeViewerDeployment();
    if (active) return { state: "busy", deploymentId: active.deploymentId, revision: active.revision };
    const revision = await this.adapter.resolveRevision(requestedRevision);
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("canonical repository did not resolve an immutable commit SHA");
    const receipt = this.journal.admitViewerDeployment({ idempotencyKey: request.idempotencyKey, requestedRevision, revision }, this.owner);
    if (receipt.state === "accepted") {
      const status = this.journal.viewerDeployment(receipt.deploymentId);
      if (status && !status.terminal && status.owner.pid === this.owner.pid && status.owner.startIdentity === this.owner.startIdentity) {
        this.start(status);
      }
    }
    return receipt;
  }

  private runAdmissionExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.admissionQueue.then(work);
    this.admissionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  readViewerDeployment(deploymentId: string): ViewerDeploymentStatus | null {
    return this.journal.viewerDeployment(deploymentId);
  }

  async recover(): Promise<ViewerDeploymentStatus | null> {
    await this.adapter.reconcile();
    const active = this.journal.activeViewerDeployment();
    if (!active) return null;
    const sameOwner = active.owner.pid === this.owner.pid && active.owner.startIdentity === this.owner.startIdentity;
    if (!sameOwner && this.ownerAlive(active.owner)) return active;
    const claimed = sameOwner ? active : this.journal.updateViewerDeployment(active.deploymentId, { owner: this.owner });
    this.start(claimed);
    return claimed;
  }

  async waitForDeployment(deploymentId: string): Promise<ViewerDeploymentStatus | null> {
    await this.tasks.get(deploymentId);
    return this.journal.viewerDeployment(deploymentId);
  }

  /** Production #518: the runtime-host Bun process loads its modules once at
      boot, and its container runs a baked image — a succeeded exact-SHA
      deployment previously left the singleton executing a stale generation
      (the pre-#389 broker kept failing promptless Claude resume adoption
      with "message content is required" for hours after the fix shipped).
      After the blue-green promotion is healthy, a generation
      mismatch stages the freshly built candidate image as the successor
      runtime-host release. The deployment remains active in its durable
      host-handoff phase until staging succeeds. Only then does it become
      terminal and signal the predecessor to release the singleton fence. */
  private async stageDriftedHostSuccessor(status: ViewerDeploymentStatus): Promise<RuntimeHostHandoffContext | null> {
    if (!this.hostGeneration || !status.candidate) return null;
    const running = this.hostGeneration();
    if (running.revision === status.revision && running.image === status.candidate.image) return null;
    await this.adapter.stageRuntimeHostSuccessor(status.candidate);
    return {
      deploymentId: status.deploymentId,
      revision: status.revision,
      successor: status.candidate,
      previous: running,
    };
  }

  private start(status: ViewerDeploymentStatus): void {
    if (this.tasks.has(status.deploymentId) || status.terminal) return;
    const task = this.run(status)
      .catch((error) => console.error(`[viewer deployment] ${safeError(error)}`))
      .finally(() => this.tasks.delete(status.deploymentId));
    this.tasks.set(status.deploymentId, task);
  }

  private async run(initial: ViewerDeploymentStatus): Promise<void> {
    let status = initial;
    try {
      while (!status.terminal) {
        if (status.phase === "admitted") {
          status = this.journal.updateViewerDeployment(status.deploymentId, { phase: "building" });
          continue;
        }
        if (status.phase === "building") {
          const candidate = await this.adapter.buildCandidate(status.deploymentId, status.revision);
          status = this.journal.updateViewerDeployment(status.deploymentId, { phase: "candidate-starting", candidate });
          continue;
        }
        if (status.phase === "candidate-starting") {
          if (!status.candidate) throw new Error("candidate identity is missing");
          await this.adapter.startCandidate(status.candidate);
          status = this.journal.updateViewerDeployment(status.deploymentId, { phase: "candidate-health" });
          continue;
        }
        if (status.phase === "candidate-health") {
          if (!status.candidate) throw new Error("candidate identity is missing");
          const evidence = await this.adapter.verifyCandidate(status.candidate);
          const health = [...status.health, evidence];
          if (!evidence.ok) {
            await this.adapter.retire(status.candidate);
            status = this.journal.updateViewerDeployment(status.deploymentId, {
              health,
              phase: "failed",
              terminal: true,
              error: evidence.detail ?? "candidate health gate failed",
            });
            continue;
          }
          const previous = await this.adapter.currentRelease();
          if (!previous) throw new Error("previous healthy release identity is unavailable");
          status = this.journal.updateViewerDeployment(status.deploymentId, { health, previous, phase: "promoting" });
          continue;
        }
        if (status.phase === "promoting") {
          if (!status.candidate) throw new Error("candidate identity is missing");
          await this.adapter.promote(status.candidate);
          status = this.journal.updateViewerDeployment(status.deploymentId, { phase: "post-promotion-health" });
          continue;
        }
        if (status.phase === "post-promotion-health") {
          if (!status.candidate) throw new Error("candidate identity is missing");
          const evidence = await this.adapter.verifyPromoted(status.candidate);
          const health = [...status.health, evidence];
          if (evidence.ok) {
            if (!status.previous) throw new Error("previous release identity is missing");
            await this.adapter.retainOnly([status.candidate, status.previous]);
            status = this.journal.updateViewerDeployment(status.deploymentId, {
              error: null,
              health,
              phase: "host-handoff",
              terminal: false,
            });
            continue;
          }
          status = this.journal.updateViewerDeployment(status.deploymentId, {
            health,
            phase: "rolling-back",
            error: evidence.detail ?? "post-promotion health gate failed",
          });
          continue;
        }
        if (status.phase === "host-handoff") {
          if (!status.candidate) throw new Error("candidate identity is missing");
          const handoff = await this.stageDriftedHostSuccessor(status);
          status = this.journal.updateViewerDeployment(status.deploymentId, {
            error: null,
            phase: "succeeded",
            terminal: true,
          });
          if (handoff) this.onHostHandoff?.(handoff);
          continue;
        }
        if (status.phase === "rolling-back") {
          if (!status.previous || !status.candidate) throw new Error("rollback release identity is missing");
          await this.adapter.rollback(status.previous, status.candidate);
          await this.adapter.retire(status.candidate);
          status = this.journal.updateViewerDeployment(status.deploymentId, { phase: "rolled-back", terminal: true });
          continue;
        }
        throw new Error(`unsupported deployment phase: ${status.phase}`);
      }
    } catch (error) {
      const message = safeError(error);
      const latest = this.journal.viewerDeployment(status.deploymentId) ?? status;
      if (latest.phase === "host-handoff") {
        this.journal.updateViewerDeployment(latest.deploymentId, {
          error: message,
          phase: "host-handoff",
          terminal: false,
        });
        return;
      }
      const promotionStarted = latest.phase === "promoting" || latest.phase === "post-promotion-health" || latest.phase === "rolling-back";
      if (promotionStarted && latest.previous && latest.candidate) {
        try {
          const rolling = latest.phase === "rolling-back"
            ? latest
            : this.journal.updateViewerDeployment(latest.deploymentId, { phase: "rolling-back", error: message });
          await this.adapter.rollback(rolling.previous!, rolling.candidate!);
          await this.adapter.retire(rolling.candidate!);
          this.journal.updateViewerDeployment(rolling.deploymentId, { phase: "rolled-back", terminal: true, error: message });
          return;
        } catch (rollbackError) {
          this.journal.updateViewerDeployment(latest.deploymentId, {
            phase: "failed",
            terminal: true,
            error: `${message}; rollback failed: ${safeError(rollbackError)}`,
          });
          return;
        }
      }
      if (latest.candidate) {
        try { await this.adapter.retire(latest.candidate); }
        catch (cleanupError) {
          this.journal.updateViewerDeployment(latest.deploymentId, {
            phase: "failed",
            terminal: true,
            error: `${message}; candidate cleanup failed: ${safeError(cleanupError)}`,
          });
          return;
        }
      }
      this.journal.updateViewerDeployment(latest.deploymentId, { phase: "failed", terminal: true, error: message });
    }
  }
}
