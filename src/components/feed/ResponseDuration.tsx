import { workedDurationCaption } from "../turnDuration";

export function ResponseDuration({ durationMs }: { durationMs: number }) {
  return (
    <div data-response-duration className="mb-3 ml-9 flex items-center gap-2 text-[11px] font-semibold text-muted">
      <span className="h-px w-5 bg-border" aria-hidden />
      <span className="tabular-nums">{workedDurationCaption(durationMs)}</span>
    </div>
  );
}
