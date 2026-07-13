import type { translate } from "@/lib/i18n";

import { GlyphIcon, type GlyphName } from "../../icons";
import { hhmm } from "../../utils";
import { mdBlocks } from "../markdown";
import { tr } from "../parse";

type ProtocolPayload = Record<string, unknown>;

const PROTOCOL_TYPE_META: Record<string, { icon: GlyphName; labelKey: Parameters<typeof translate>[1]; tone: "amber" | "accent" }> = {
  shutdown_request: { icon: "shutdown", labelKey: "render.shutdownRequest", tone: "amber" },
  shutdown_response: { icon: "shutdown", labelKey: "render.shutdownResponse", tone: "amber" },
  plan_approval_request: { icon: "plan", labelKey: "render.planRequest", tone: "accent" },
  plan_approval_response: { icon: "plan", labelKey: "render.planVerdict", tone: "accent" },
};

function protocolToneClass(tone: "amber" | "accent"): string {
  return tone === "amber" ? "border-[#d89b21]/35 bg-[#fff9ea] text-[#9a6500]" : "border-accent/25 bg-accent/10 text-accent";
}

/** tmsg text is sometimes an inline protocol envelope (shutdown/plan-approval
    handshake) instead of prose; any non-JSON or non-object payload falls back
    to the plain tmsg render, so parsing stays defensive end to end. */
export function parseProtocolPayload(text: string): ProtocolPayload | null {
  let trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ProtocolPayload;
  } catch {
    return null;
  }
  return null;
}

function asProtocolString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function ApproveChip({ approve }: { approve: boolean }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-extrabold ${approve ? "border-ok/25 bg-[#eefaf1] text-ok" : "border-err/25 bg-[#fff0f0] text-err"}`}>
      {approve ? tr("render.approved") : tr("render.rejected")}
    </span>
  );
}

function ProtocolMeta({ payload }: { payload: ProtocolPayload }) {
  const from = asProtocolString(payload.from);
  const requestId = asProtocolString(payload.requestId);
  const ts = hhmm(payload.timestamp);
  if (!from && !requestId && !ts) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-dim">
      {from ? <span>{tr("render.from", { from })}</span> : null}
      {requestId ? (
        <span className="truncate font-mono" title={requestId}>
          {requestId.length > 40 ? requestId.slice(0, 40) + "…" : requestId}
        </span>
      ) : null}
      {ts ? <span className="tabular-nums">{ts}</span> : null}
    </div>
  );
}

export function ProtocolMessageBody({ payload }: { payload: ProtocolPayload }) {
  const type = asProtocolString(payload.type);
  const meta = type ? PROTOCOL_TYPE_META[type] : undefined;
  if (!meta) {
    return (
      <div className="text-[13px]">
        <div className="text-dim">{tr("render.structured")}</div>
        <details className="mt-1 text-[12px]">
          <summary className="cursor-pointer list-none font-semibold text-accent">{tr("render.showJson")}</summary>
          <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md bg-chip px-2.5 py-2 font-mono text-[11.5px]">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </details>
      </div>
    );
  }
  const approve = typeof payload.approve === "boolean" ? payload.approve : undefined;
  const prose = asProtocolString(payload.reason) ?? asProtocolString(payload.feedback);
  return (
    <div className="text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11.5px] font-bold ${protocolToneClass(meta.tone)}`}>
          <GlyphIcon name={meta.icon} className="h-3.5 w-3.5" />
          {tr(meta.labelKey)}
        </span>
        {approve !== undefined ? <ApproveChip approve={approve} /> : null}
      </div>
      {prose ? <div className="mt-1.5 whitespace-pre-wrap break-words">{mdBlocks(prose)}</div> : null}
      <ProtocolMeta payload={payload} />
    </div>
  );
}
