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

export interface ViewerDeploymentAdapter {
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
            status = this.journal.updateViewerDeployment(status.deploymentId, { health, phase: "succeeded", terminal: true });
            continue;
          }
          status = this.journal.updateViewerDeployment(status.deploymentId, {
            health,
            phase: "rolling-back",
            error: evidence.detail ?? "post-promotion health gate failed",
          });
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
