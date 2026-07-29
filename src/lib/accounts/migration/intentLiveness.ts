import type { ConversationMigration, MigrationEngine, MigrationIntent } from "./contracts";

export const MIGRATION_INTENT_PROGRESS_TIMEOUT_MS = 5 * 60_000;
export const MIGRATION_DELIVERY_CANCELLATION_PREFIX = "delivery cancelled because";
export const STOPPED_MIGRATION_DELIVERY_REASON =
  `${MIGRATION_DELIVERY_CANCELLATION_PREFIX} its owning account migration was stopped; send again to authorize a fresh delivery`;
export const ROLLED_BACK_MIGRATION_DELIVERY_REASON =
  `${MIGRATION_DELIVERY_CANCELLATION_PREFIX} its owning account migration was rolled back; send again to authorize a fresh delivery`;

interface MigrationIntentContext {
  engineRouting: Record<MigrationEngine, { activeAccountId: string | null }>;
  conversations: Record<string, { migration: ConversationMigration | null }>;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function migrationIntentLastProgressAt(
  context: Pick<MigrationIntentContext, "conversations">,
  intent: MigrationIntent,
): number {
  let latest = timestamp(intent.updatedAt);
  for (const conversation of Object.values(context.conversations)) {
    if (conversation.migration?.intentId !== intent.id) continue;
    if (conversation.migration.phase === "requested" || conversation.migration.phase === "waiting-turn") continue;
    latest = Math.max(latest, timestamp(conversation.migration.updatedAt));
  }
  return latest;
}

export function migrationIntentCanEnroll(
  context: MigrationIntentContext,
  intent: MigrationIntent,
  observedAt: number,
): boolean {
  if (intent.state !== "draining") return false;
  if (context.engineRouting[intent.engine].activeAccountId !== intent.targetId) return false;
  return !migrationIntentIsStale(context, intent, observedAt);
}

export function migrationIntentIsStale(
  context: Pick<MigrationIntentContext, "conversations">,
  intent: MigrationIntent,
  observedAt: number,
): boolean {
  const lastProgressAt = migrationIntentLastProgressAt(context, intent);
  return lastProgressAt > observedAt
    || observedAt - lastProgressAt >= MIGRATION_INTENT_PROGRESS_TIMEOUT_MS;
}
