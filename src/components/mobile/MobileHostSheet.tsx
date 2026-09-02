"use client";

import { useState } from "react";

import { useLocale, type MessageKey } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import type { ConnectionState } from "../runtime/runtimeModel";
import { MobileSheet, MobileSheetDivider, MobileSheetSection } from "./MobileSheet";
import { showReceipt } from "./MobileReceipt";

/*
 * Host details (issue #1439, lane 2; docs/design/mobile-v2/README.md §2 rule 5,
 * §4.1). Everything about the host is one tap away and nowhere else: the
 * background processes with their PIDs and Kill, the runtime connection, and
 * the hidden conversations — never a row on the board itself.
 *
 * Kill acts on the tap that names it (README Q4: no confirmation prompts
 * anywhere on the phone) and answers with a receipt. A killed background
 * process has no inverse — nothing can un-send SIGTERM — so the receipt
 * carries none; a failure says so on the row instead of pretending.
 */

/** What the runtime row says beside its badge. */
const RUNTIME_WORD: Record<ConnectionState, MessageKey> = {
  live: "mobile2.host.runtimeLive",
  reconnecting: "mobile2.host.runtimeOffline",
  degraded: "mobile2.host.runtimeDegraded",
  offline: "mobile2.host.runtimeOffline",
};
const RUNTIME_TONE: Record<ConnectionState, string> = {
  live: "bg-success-soft text-success",
  reconnecting: "bg-warning-soft text-warning",
  degraded: "bg-warning-soft text-warning",
  offline: "bg-danger-soft text-danger",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-4 text-body">
      <span className="shrink-0 text-label font-semibold text-secondary">{label}</span>
      <span className="ml-auto inline-flex min-w-0 items-center gap-2 text-label font-medium text-secondary">{children}</span>
    </div>
  );
}

/** One background process: what it is, its PID, and Kill. */
function BackgroundTask({ file, onKilled }: { file: FileEntry; onKilled?: (path: string) => void }) {
  const { t } = useLocale();
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState("");
  const title = cleanTitle(file.cmdDesc || file.title, 80);
  const live = file.activity === "live" || file.proc === "running";
  const kill = async () => {
    setKilling(true);
    setError("");
    try {
      const response = await fetch("/api/proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: file.path }),
      });
      const body = (await response.json()) as { ok?: boolean; pid?: number; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error ?? t("task.stopFailed"));
        return;
      }
      showReceipt(t("mobile2.host.killed", { pid: body.pid ?? file.pid ?? "" }));
      onKilled?.(file.path);
    } catch {
      setError(t("common.serverUnavailable"));
    } finally {
      setKilling(false);
    }
  };
  return (
    <div className="flex min-h-11 items-center gap-3 px-4" data-mobile2-host-task={file.path}>
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${live ? "bg-success" : "bg-strong"}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold leading-[1.25] text-primary">{title}</span>
        <span className="truncate font-mono text-label tabular-nums text-muted">
          {error ? <span className="text-danger">{error}</span> : t("mobile2.host.pid", { pid: file.pid ?? "—" })}
        </span>
      </span>
      {file.pid === null ? null : (
        <button
          type="button"
          data-mobile2-kill={file.path}
          disabled={killing}
          aria-label={t("mobile2.host.killTask", { title })}
          className="-mr-2.5 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[8px] px-2.5 text-ui font-semibold text-danger disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          onClick={() => void kill()}
        >
          {t("task.kill")}
        </button>
      )}
    </div>
  );
}

export function MobileHostSheet({
  projectName,
  runtime,
  tasks,
  hiddenCount,
  onOpenCatalog,
  onClose,
  onKilled,
  leading,
  children,
}: {
  projectName: string;
  runtime: ConnectionState;
  /** The parentless background processes that used to dock above the board. */
  tasks: readonly FileEntry[];
  /** Conversations the board is not showing, reachable through the catalog. */
  hiddenCount: number;
  onOpenCatalog?: () => void;
  onClose: () => void;
  onKilled?: (path: string) => void;
  /** The focused conversation's handoff control, when there is one. */
  leading?: React.ReactNode;
  /** The folded worker / quiet / readiness strips (retired in lane 10). */
  children?: React.ReactNode;
}) {
  const { t } = useLocale();
  return (
    <MobileSheet name="host" title={t("mobile2.host.title", { project: projectName })} onClose={onClose}>
      {leading ? <div className="px-4 pb-1">{leading}</div> : null}
      <Row label={t("mobile2.host.runtime")}>
        <span className={`inline-flex h-5 shrink-0 items-center rounded-full px-[7px] text-caption font-semibold leading-none ${RUNTIME_TONE[runtime]}`} data-connection={runtime}>
          {t(`runtime.${runtime}`)}
        </span>
        <span className="truncate">{t(RUNTIME_WORD[runtime])}</span>
      </Row>
      <MobileSheetSection count={tasks.length}>{t("mobile2.host.background")}</MobileSheetSection>
      {tasks.length ? (
        tasks.map((file) => <BackgroundTask key={file.path} file={file} onKilled={onKilled} />)
      ) : (
        <div className="px-4 py-3 text-center text-ui text-muted">{t("mobile2.host.noBackground")}</div>
      )}
      {onOpenCatalog ? (
        <>
          <MobileSheetSection>{t("mobile2.host.hidden")}</MobileSheetSection>
          <button
            type="button"
            data-mobile2-host-catalog
            className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            onClick={onOpenCatalog}
          >
            <span className="min-w-0 flex-1 truncate">{t("mobile2.host.quiet", { count: hiddenCount })}</span>
            <span className="ml-auto shrink-0 text-label font-medium text-muted">{t("mobile2.host.catalog")}</span>
          </button>
        </>
      ) : null}
      {children ? (
        <>
          <MobileSheetDivider />
          {children}
        </>
      ) : null}
    </MobileSheet>
  );
}
