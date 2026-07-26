"use client";

import type { DeviceAttentionOffer } from "@/lib/attention/service";
import type { AttentionRequestV1 } from "@/lib/attention/types";
import type { TFunction } from "@/lib/i18n";

/**
 * The overlay's action row — the band that is 0px tall until something needs an
 * answer (#691), and the surface where #688's consent contract becomes visible.
 *
 * Three things live here and nowhere else: the pending request with its
 * accept/preview/decline, the standing-consent chip with its revocation on the
 * same surface that is using it (D3), and the return affordance (D8's promise
 * that you can always get back).
 */

export interface AttentionPreview {
  title: string;
  project: string;
  /** One line, bounded and redacted upstream. Never a thumbnail, and never the
      target's contents — that is what the digest and the transcript are for. */
  detail: string | null;
}

export interface AttentionActionRowProps {
  offer: DeviceAttentionOffer | null;
  /** The text card shown while previewing. A preview NEVER moves the view, for
      any target type. */
  preview?: AttentionPreview | null;
  autoFollow?: { scope: "session" | "project"; label: string } | null;
  onAccept: (request: AttentionRequestV1) => void;
  onPreview: (request: AttentionRequestV1) => void;
  onDecline: (request: AttentionRequestV1) => void;
  onReturn: (request: AttentionRequestV1) => void;
  onRevokeAutoFollow?: () => void;
  /** Mobile controls are larger, deliberately. */
  controlSize: number;
  t: TFunction;
}

function Button({
  label,
  onClick,
  tone,
  size,
  testId,
}: {
  label: string;
  onClick: () => void;
  tone: "primary" | "secondary";
  size: number;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{ minHeight: size }}
      className={`inline-flex flex-1 items-center justify-center rounded-control px-3 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        tone === "primary"
          ? "bg-accent text-on-accent hover:bg-accent/90"
          : "border border-border text-secondary hover:bg-sunken"
      }`}
    >
      {label}
    </button>
  );
}

export function AttentionActionRow({
  offer,
  preview,
  autoFollow,
  onAccept,
  onPreview,
  onDecline,
  onReturn,
  onRevokeAutoFollow,
  controlSize,
  t,
}: AttentionActionRowProps) {
  /* Standing consent is visible wherever it is in force and revocable from
     exactly there — it is never a setting you have to remember the location of. */
  const consent = autoFollow ? (
    <div className="flex items-center gap-2 px-2 py-1" data-testid="attention-auto-follow">
      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-caption text-accent">
        {t("attention.autoFollow")} · {autoFollow.label}
      </span>
      <button
        type="button"
        data-testid="attention-auto-follow-revoke"
        onClick={onRevokeAutoFollow}
        className="text-caption text-muted underline hover:text-secondary"
      >
        {t("attention.autoFollowRevoke")}
      </button>
    </div>
  ) : null;

  if (!offer) return consent;

  const { request, status, returnAvailable } = offer;

  if (status === "withdrawn") {
    return (
      <div className="px-2 py-1 text-caption text-muted" data-testid="attention-withdrawn">
        {t("attention.followedElsewhere")}
      </div>
    );
  }

  if (status === "following") {
    /* The return control names where you came from for its window, then
       collapses into a line that still restores the same point when tapped. */
    return (
      <div className="flex items-center gap-2 px-2 py-1">
        {consent}
        <button
          type="button"
          data-testid="attention-return"
          onClick={() => onReturn(request)}
          style={{ minHeight: controlSize }}
          className={`inline-flex items-center rounded-control px-3 text-caption ${
            returnAvailable ? "border border-border text-secondary hover:bg-sunken" : "text-muted underline"
          }`}
        >
          {returnAvailable ? t("attention.return") : t("attention.returnLine")}
        </button>
      </div>
    );
  }

  if (status !== "actionable") return consent;

  const opening = request.intent === "open";
  const previewing = request.state === "previewing";

  return (
    <div className="flex flex-col gap-1 px-2 py-1" data-testid="attention-request">
      {/* Announced once on arrival; the marker is a button carrying the same
          text, so no step of the flow requires perceiving a transition. */}
      <p className="text-caption text-secondary" role="status" aria-live="polite">
        <span className="font-medium">{request.reason}</span>{" "}
        {/* D8: the operator hears WHICH of show/open they are agreeing to,
            before they agree to it. */}
        <span data-testid="attention-intent">{opening ? t("attention.willOpen") : t("attention.willShow")}</span>
        {request.resolution === "approximate" ? (
          <span data-testid="attention-approximate" className="text-muted"> {t("attention.approximate")}</span>
        ) : null}
      </p>

      {previewing && preview ? (
        <div className="rounded-control border border-border px-2 py-1 text-caption" data-testid="attention-preview-card">
          <span className="font-medium">{preview.title}</span>
          <span className="text-muted"> · {preview.project}</span>
          {preview.detail ? <p className="text-muted">{preview.detail}</p> : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          testId="attention-accept"
          label={opening ? t("attention.acceptOpen") : t("attention.accept")}
          tone="primary"
          size={controlSize}
          onClick={() => onAccept(request)}
        />
        {!previewing ? (
          <Button
            testId="attention-preview"
            label={t("attention.preview")}
            tone="secondary"
            size={controlSize}
            onClick={() => onPreview(request)}
          />
        ) : null}
        <Button
          testId="attention-decline"
          label={previewing ? t("attention.previewClose") : t("attention.decline")}
          tone="secondary"
          size={controlSize}
          onClick={() => onDecline(request)}
        />
      </div>
      {consent}
    </div>
  );
}
