"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { FileEntry } from "@/lib/types";

import type { SeatRotateFlow } from "../mobile/MobileOrchestratorSheet";
import { seatFlowStorage } from "../mobile/orchestratorDraftStorage";
import {
  deriveOrchestratorPanelState,
  resolveSeatFile,
  seatRequestSettled,
  type OrchestratorPanelState,
  type OrchestratorSeatStatus,
} from "./seatState";
import type { OrchestratorIncumbent } from "./incumbent";
import { useOrchestratorIncumbent } from "./useOrchestratorIncumbent";
import { useSeatConfirm } from "./useSeatConfirm";
import { useSeatSurface } from "./useSeatSurface";

/**
 * The seat sheet's live view, for a host that is NOT the seat's own card
 * (mobile v2 lane 3, README §4.2/§4.5).
 *
 * The conversation screen's `⋯` carries an «Orchestrator seat» row on the
 * seat's own conversation, and that row opens `MobileOrchestratorSheet` — the
 * one seat surface — over the conversation. What the sheet needs to render a
 * LIVE seat is assembled here: the panel state, the incumbent's own reading,
 * and the rotate flow on the dock's durable Rotate keys, so a rotation half
 * written on one surface continues on the other.
 *
 * Deliberately only the live view. Creating a seat, resuming a stuck
 * designation and re-reading an unavailable one all belong to the surface that
 * exists WITHOUT a seat conversation — the board's seat card — and this hook
 * answers null unless the project's seat is live and holds the conversation it
 * was asked about. The sheet's `onConfirm` (create / resume) is therefore
 * unreachable from this host, and its primary action is «Open conversation».
 *
 * The seat READ is the caller's: the conversation screen already polls it for
 * the switcher's orchestrator section, and a second `useOrchestratorSeat` on
 * the same key would poll the same route twice.
 */
export interface SeatPanel {
  state: OrchestratorPanelState;
  status: OrchestratorSeatStatus | null;
  file: FileEntry;
  incumbent: OrchestratorIncumbent | null;
  pendingMandate: string;
  viewerMcpRegistered: boolean;
  rotate: SeatRotateFlow;
  onRecheck: () => void;
}

export function useSeatPanel(input: {
  project: string;
  files: readonly FileEntry[];
  /** The caller's seat read (`useOrchestratorSeat`), shared rather than repolled. */
  seat: { status: OrchestratorSeatStatus | null; failed: boolean; refresh: () => Promise<void> };
  /** The host's conversation IS the project's seat. The caller already resolves
      that key for the switcher's orchestrator section, so it is not resolved a
      second time here. */
  holdsSeat: boolean;
  /** The sheet is open — the incumbent's slower read is paid for only then. */
  open: boolean;
}): SeatPanel | null {
  const { project, files, seat, holdsSeat, open } = input;
  const { status, failed, refresh } = seat;
  const seatConversationId = status?.seat?.conversationId ?? null;

  const { incumbent: read, refresh: refreshIncumbent } = useOrchestratorIncumbent(project, holdsSeat && open);
  /* A reading is only about the conversation it names: right after a rotation
     the seat has already advanced to the successor while this slower poll still
     describes the predecessor. */
  const incumbent = read && read.conversationId === seatConversationId ? read : null;
  const file = useMemo(
    () => resolveSeatFile({
      files,
      conversationId: seatConversationId,
      seatPath: status?.seat?.path ?? null,
      currentPath: incumbent?.transcriptPath ?? null,
    }),
    [files, seatConversationId, status?.seat?.path, incumbent?.transcriptPath],
  );
  const surface = useSeatSurface(file);

  /* The rotate flow, on the dock's own Rotate keys: one durable intent per
     submission wherever it was started (`useSeatConfirm`). */
  const rotateStorage = useMemo(() => seatFlowStorage("Rotate", project), [project]);
  const rotate = useSeatConfirm({ url: "/api/orchestrator/rotate", project, storage: rotateStorage, field: "requestId", status, refresh });

  const [rotateFrom, setRotateFrom] = useState<string | null>(null);
  /* Opening the draft is a READ first, so it opens on the incumbent's own
     parameters rather than the generic defaults (issue #1347). */
  const [rotateOpening, setRotateOpening] = useState(false);

  const state = deriveOrchestratorPanelState({
    status,
    statusFailed: failed,
    submitting: rotate.submitting,
    submitFailure: rotate.failure,
    file,
    surface,
    incumbent,
  });

  /* A rotation whose outcome is not yet settled KEEPS the draft; settled, the
     draft gives way to whatever the seat read now says. */
  const rotateUnsettled = rotate.submitting
    || (rotate.failure !== null && !seatRequestSettled(status, rotate.failure.clientRequestId));
  const rotatingLive = state.kind === "live" && rotateFrom !== null && rotateFrom === state.conversationId;
  const rotatingVacant = state.kind !== "live" && rotateFrom !== null && rotateUnsettled && status?.seat != null;
  const rotating = rotatingLive || rotatingVacant;
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the draft closes itself when the seat it was replacing is no longer the seat */
    if (rotateFrom !== null && !rotating) setRotateFrom(null);
  }, [rotateFrom, rotating]);

  const openRotate = useCallback(async () => {
    const from = status?.seat?.conversationId ?? null;
    if (!from) return;
    setRotateOpening(true);
    try {
      await refreshIncumbent();
    } finally {
      setRotateOpening(false);
      setRotateFrom(from);
    }
  }, [status?.seat?.conversationId, refreshIncumbent]);

  const rotateFlow: SeatRotateFlow = {
    open: rotating,
    seat: rotatingLive && state.kind === "live" ? state.seat : rotatingVacant ? status?.seat ?? null : null,
    vacated: rotatingVacant,
    opening: rotateOpening,
    submitting: rotate.submitting,
    failure: rotate.failure,
    onOpen: () => void openRotate(),
    onCancel: () => setRotateFrom(null),
    onConfirm: (payload) => void rotate.submit(payload),
  };

  if (!holdsSeat || !file || state.kind !== "live") return null;
  return {
    state,
    status,
    file,
    incumbent,
    pendingMandate: status?.pending?.mandate ?? "",
    viewerMcpRegistered: status?.viewerMcpRegistered === true,
    rotate: rotateFlow,
    onRecheck: () => void refresh(),
  };
}
