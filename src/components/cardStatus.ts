import { accountIdFromPath } from "@/lib/accounts/badge";
import { activeCardMigration } from "@/lib/accounts/migration";
import type { FileEntry } from "@/lib/types";

import { attentionId } from "./attention";
import { turnIsRunning } from "./turnDuration";

/**
 * The one operator-facing textual status of a board card (issue #961).
 *
 * A pure projection over the authorities the board already trusts — it owns no
 * state and invents no lifecycle. Each word names the authority it reads:
 *
 * 1. `needs-you` — the attention queue ({@link attentionId}), the same identity
 *    every badge/toast/push surface derives from. Frozen semantics.
 * 2. `held` — the account-switch delivery fence, read level-wise through
 *    {@link activeCardMigration} exactly like the composer's held ribbon and the
 *    outgoing message bubbles, with the registry's unsettled count.
 * 3. `running` — the open-turn condition the pinned working spinner paints from
 *    ({@link turnIsRunning}), plus the elapsed run time when the turn boundary
 *    is known.
 * 4. `queued` — a scheduled self-wake still in the future (the wakeup authority
 *    behind the ⏰ chip).
 *
 * Precedence is exactly that order; a quiet card projects `null`. A word never
 * deletes the information below it — the chips that carry the lower-priority
 * facts (wakeup, rate limit, recency, outbox bubbles) keep rendering beside it.
 */
export type CardStatus =
  | { kind: "needs-you" }
  | { kind: "held"; count: number }
  | { kind: "running"; elapsedSeconds: number | null }
  | { kind: "queued" };

export function cardStatus(file: FileEntry, nowMs: number = Date.now()): CardStatus | null {
  if (attentionId(file, nowMs / 1000) !== null) return { kind: "needs-you" };
  const migration = activeCardMigration(file.migration, accountIdFromPath(file.path));
  const held = migration?.heldDeliveries ?? 0;
  if (held > 0) return { kind: "held", count: held };
  if (turnIsRunning(file)) {
    const startedAt = file.lastTurn && file.lastTurn.endedAt === null ? file.lastTurn.startedAt : null;
    return {
      kind: "running",
      elapsedSeconds: startedAt === null ? null : Math.max(0, (nowMs - startedAt) / 1000),
    };
  }
  if (file.pendingWakeup && file.pendingWakeup.fireAt > nowMs) return { kind: "queued" };
  return null;
}
