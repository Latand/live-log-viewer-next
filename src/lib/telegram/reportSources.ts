import { readTelegramSession } from "./sessionStore";
import { telegramMcpUrl } from "./packaging";
import { validTelegramAccountId, type TelegramAccountIdentity } from "./contracts";
import { readFeedDialogsSince, type FeedDialog } from "./reportFeed";
import type { TelegramReportGroup } from "./reportContracts";

/**
 * Source discovery for a Daily Report run (issues #1086, #1091).
 *
 * THE FEED IS THE SOURCE OF "ACTIVE SINCE THE LAST RUN". The connector records
 * every settled incoming private burst to its event feed the moment it happens
 * (`reportFeed.ts`), so the dialogs a report is about are read from that file,
 * in one bounded pass, with no dependence on any list order at all. A dialog
 * ranked dead last by the connector's chat listing is exactly as visible as the
 * first one.
 *
 * The candidate WALK survives behind it, because the feed knows only what
 * arrived while the connector was running and listening: a dialog where the
 * operator did the writing, or one that was active before this connector
 * generation started, has no feed line. So the walk still runs, over the
 * candidates the feed has not already accounted for, and still decides by
 * LAST MESSAGE DATE — never by position.
 *
 * The connector's chat listing is NOT ordered by recency — it follows pinned
 * and folder order, proven on the live connector by a dialog whose last
 * message was 16 h old being absent from the first page while one last active
 * six weeks earlier ranked second. So the listing is used only to enumerate
 * candidates.
 *
 * Enumeration cannot stop at one page either. `list_chats` applies its 100-chat
 * ceiling to the dialog list BEFORE the `chat_type` filter, so an operator with
 * a hundred groups above their private dialogs would have those dialogs simply
 * not exist for this run. `get_chats` pages the same list (ids and titles only,
 * `page` 1..10), so candidates come from `list_chats` for the typed head and
 * from bounded `get_chats` pages beyond it, where a POSITIVE marked id is what
 * identifies a private dialog. The operator's GROUP picker walks the same paged
 * list for the same reason (#1091): a group below the ceiling could not be
 * chosen as a source at all while only the typed head was offered.
 *
 * The probing is deliberately dull: one single-message read per candidate,
 * sequentially. The connector died once under three concurrent 120-message
 * reads, so NOTHING here runs in parallel — not the feed read, not the
 * listings, not the probes — and nothing asks for more than one message at a
 * time. ONE bound keeps that honest on a large account — {@link MAX_PROBES}
 * probes for the whole run — and every candidate inside it is probed. An
 * earlier revision also stopped after a run of consecutive stale candidates,
 * which was a recency assumption about a list this module opens by saying is
 * not ordered by recency: a dialog answered an hour ago, sitting below a block
 * of dormant ones, was silently dropped from the report.
 *
 * The resulting plan is written to owner-only state and READ by the run from
 * there — it never travels through the prompt — because it names the
 * operator's private dialogs, which must not enter a transcript, a launch
 * profile, or the registry.
 */

export type TelegramChatKind = "user" | "group";

export type TelegramChatSummary = {
  id: string;
  kind: TelegramChatKind;
  title: string;
  username: string | null;
  unread: number;
};

export interface TelegramReadPort {
  /** The account the connector is actually logged in as, sanitized to the
      fields Connect records — including the numeric id the verifier compares
      (#1091). `null` when the connector answered something that is not an
      account. */
  getMe(): Promise<TelegramAccountIdentity | null>;
  /** Private dialogs the connector's incoming feed recorded as active at or
      after `sinceMs`, newest first (#1091). Empty when the feed is off or has
      seen nothing — never an error, because the walk below still runs. */
  feedDialogs(input: { sinceMs: number }): Promise<FeedDialog[]>;
  /** One bounded page of chats of a kind, in whatever order the connector
      returns them — the caller must not treat it as recency. */
  listChats(input: { kind: TelegramChatKind; limit: number }): Promise<TelegramChatSummary[]>;
  /** One page of the raw dialog list: ids and titles of every kind, which is
      the only way past `list_chats`'s pre-filter ceiling. */
  pageChats(input: { page: number; pageSize: number }): Promise<Array<{ id: string; title: string }>>;
  /** ISO instant of the chat's most recent message, or `null` when unknown. */
  lastMessageAt(chatId: string): Promise<string | null>;
}

/** The connector's own page ceiling; asking for more is refused upstream. */
export const CHAT_PAGE_LIMIT = 100;
/** How many `get_chats` pages the enumeration walks. Three pages of the
    ceiling reach 300 dialogs, well past where an account's active private
    conversations live, and the connector refuses a page above 10 anyway. */
export const MAX_CHAT_PAGES = 3;
/** Hard ceiling on single-message probes for one run, and the ONLY bound on
    the walk: every candidate up to it is probed, whatever the ones before it
    said, because the list order is not recency. */
export const MAX_PROBES = 150;
/** Private dialogs carried into one report, newest activity first. */
export const MAX_PRIVATE_DIALOGS = 25;

export type ReportSourceDialog = {
  id: string;
  title: string;
  lastMessageAt: string;
};

export type ReportSourcePlan = {
  version: 1;
  promptVersion: string;
  windowStart: string;
  windowEnd: string;
  privateDialogs: ReportSourceDialog[];
  groups: TelegramReportGroup[];
  /** How many single-message probes the plan cost, for the run log. */
  probes: number;
  /** How many of the plan's dialogs the incoming feed supplied — the ones no
      list order and no probe budget could have hidden (#1091). */
  feedDialogs: number;
  /** Whether more active dialogs existed than the plan carries. */
  truncated: boolean;
  /** Whether the walk ran out of probe budget before it ran out of
      candidates, so the plan is a bounded view rather than a complete one.
      Dialogs the feed supplied are unaffected by it either way. */
  probeBudgetExhausted: boolean;
};

/** Telegram requires every bot username to end in `bot`, so the listing alone
    identifies bots — no extra per-chat call, no guessing from titles. */
export function isBotDialog(chat: TelegramChatSummary): boolean {
  return (chat.username ?? "").toLowerCase().endsWith("bot");
}

/** Telegram marks user ids positive and every group/channel id negative, so a
    raw dialog id identifies a private dialog with no extra call. */
export function isPrivateChatId(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * Candidate private dialogs, in dialog-list order, without the pre-filter
 * ceiling.
 *
 * The typed page comes first because it carries usernames, which is what drops
 * bots without a probe (and keeps them dropped: a bot recognised there is
 * excluded from the untyped pages too, which carry no username). The paged
 * remainder contributes ids that look like private dialogs and nothing more.
 * Order here decides only what is PROBED first, never what is selected —
 * selection is by last-message date.
 */
async function candidateDialogs(port: TelegramReadPort): Promise<Array<{ id: string; title: string }>> {
  const typed = await port.listChats({ kind: "user", limit: CHAT_PAGE_LIMIT });
  const seen = new Set<string>();
  const candidates: Array<{ id: string; title: string }> = [];
  for (const chat of typed) {
    if (seen.has(chat.id)) continue;
    /* A bot is marked seen and NOT added, so the untyped pages below — which
       carry no username to recognise it by — cannot let it back in. */
    seen.add(chat.id);
    if (isBotDialog(chat)) continue;
    candidates.push({ id: chat.id, title: chat.title });
  }
  for (let page = 1; page <= MAX_CHAT_PAGES; page += 1) {
    /* Sequential on purpose: see the module comment. */
    const rows = await port.pageChats({ page, pageSize: CHAT_PAGE_LIMIT });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (seen.has(row.id) || !isPrivateChatId(row.id)) continue;
      seen.add(row.id);
      candidates.push(row);
    }
    if (rows.length < CHAT_PAGE_LIMIT) break;
  }
  return candidates;
}

/**
 * Builds the source plan for one window.
 *
 * Private dialogs come from two passes, in this order and never in parallel:
 *
 *  1. THE FEED — every dialog it recorded as active inside the window. These
 *     cost no probe and depend on no list order, so an active dialog ranked
 *     last by the connector is in the plan regardless of what the walk reaches.
 *  2. THE WALK — every remaining candidate, probed in list order until the
 *     probe budget runs out, carried when its last message falls in the window.
 *     Position never decides whether a dialog is LOOKED at; the date decides
 *     whether it is CARRIED.
 *
 * Groups are exactly what the operator picked, with their full/light flag — a
 * group is a source because the operator said so, never because it was busy.
 */
export async function planReportSources(
  port: TelegramReadPort,
  input: { windowStart: string; windowEnd: string; groups: readonly TelegramReportGroup[]; promptVersion: string },
): Promise<ReportSourcePlan> {
  const windowStart = Date.parse(input.windowStart);
  const fromFeed = await port.feedDialogs({ sinceMs: windowStart });
  const active: ReportSourceDialog[] = [];
  const carried = new Set<string>();
  for (const dialog of fromFeed) {
    if (carried.has(dialog.id)) continue;
    carried.add(dialog.id);
    active.push({ id: dialog.id, title: dialog.title, lastMessageAt: dialog.lastMessageAt });
  }
  /* Sequential on purpose: see the module comment. */
  const candidates = (await candidateDialogs(port)).filter((chat) => !carried.has(chat.id));
  let probes = 0;
  for (const chat of candidates) {
    if (probes >= MAX_PROBES) break;
    /* Sequential on purpose: see the module comment. */
    const at = await port.lastMessageAt(chat.id);
    probes += 1;
    const instant = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(instant) || instant < windowStart) continue;
    active.push({ id: chat.id, title: chat.title, lastMessageAt: new Date(instant).toISOString() });
  }
  active.sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
  return {
    version: 1,
    promptVersion: input.promptVersion,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    privateDialogs: active.slice(0, MAX_PRIVATE_DIALOGS),
    groups: input.groups.map((group) => ({ ...group })),
    probes,
    feedDialogs: carried.size,
    truncated: active.length > MAX_PRIVATE_DIALOGS,
    probeBudgetExhausted: probes >= MAX_PROBES && candidates.length > probes,
  };
}

/**
 * The groups the operator can choose as report sources (#1091).
 *
 * The typed listing alone was one pre-filtered page: `list_chats` takes its 100
 * dialogs of every kind first and filters by `chat_type` afterwards, so an
 * operator whose first hundred dialogs are private chats was offered NO groups
 * at all and could not pick the room they meet in every day. The paged raw list
 * is the way past that ceiling, exactly as it is for dialogs — and it carries
 * no kind, so a negative marked id (a group or a channel, never a private
 * dialog) is what qualifies a row there. The operator picks; the Viewer does
 * not guess which rooms matter.
 *
 * Bounded and sequential like everything else here: one typed listing plus at
 * most {@link MAX_CHAT_PAGES} pages, never two at once.
 */
export async function listReportGroups(port: TelegramReadPort): Promise<Array<{ id: string; title: string }>> {
  const typed = await port.listChats({ kind: "group", limit: CHAT_PAGE_LIMIT });
  const seen = new Set<string>();
  const groups: Array<{ id: string; title: string }> = [];
  for (const chat of typed) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    groups.push({ id: chat.id, title: chat.title });
  }
  for (let page = 1; page <= MAX_CHAT_PAGES; page += 1) {
    /* Sequential on purpose: see the module comment. */
    const rows = await port.pageChats({ page, pageSize: CHAT_PAGE_LIMIT });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (seen.has(row.id) || isPrivateChatId(row.id)) continue;
      seen.add(row.id);
      groups.push(row);
    }
    if (rows.length < CHAT_PAGE_LIMIT) break;
  }
  return groups;
}

/* ---------------------------------------------------------------------- */

type ToolResult = { content?: Array<{ type?: string; text?: string }> };

function toolText(result: unknown): string {
  const blocks = (result as ToolResult)?.content ?? [];
  return blocks.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
}

/** The connector answers with `{"results": [...]}` or, when nothing matches,
    a plain sentence. Anything that is not the JSON envelope reads as empty. */
function toolRecords(result: unknown): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(toolText(result)) as { results?: unknown };
    return Array.isArray(parsed?.results) ? parsed.results as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function chatSummary(record: Record<string, unknown>, kind: TelegramChatKind): TelegramChatSummary | null {
  const id = record.chat_id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : String(id);
  return {
    id: String(id),
    kind,
    title,
    username: typeof record.username === "string" ? record.username : null,
    unread: typeof record.unread === "number" ? record.unread : 0,
  };
}

/**
 * The production port: the shared loopback connector, over the same
 * streamable-HTTP client the readiness probe uses, authenticated with the
 * per-credential bearer token from owner-only storage.
 */
export function connectorReadPort(): TelegramReadPort {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const session = readTelegramSession();
    if (!session) throw new Error("Telegram is not connected");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "agent-log-viewer", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(telegramMcpUrl()), {
      requestInit: { headers: { Authorization: `Bearer ${session.connectorToken}` } },
    });
    try {
      await client.connect(transport);
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  return {
    async getMe() {
      /* `get_me` answers with the entity object itself rather than the
         `{"results": []}` envelope the listings use. Its `id` is the marked
         id, which for a user IS the account id (#1091). */
      const parsed = JSON.parse(toolText(await call("get_me", {}))) as { id?: unknown; name?: unknown; username?: unknown };
      const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
      const id = validTelegramAccountId(parsed?.id);
      if (!name && !id) return null;
      return {
        name,
        username: typeof parsed.username === "string" && parsed.username ? parsed.username : null,
        id,
      };
    },
    async feedDialogs(input) {
      /* Two reads, in this order, never overlapping: ask the connector where
         its feed is, then read that file locally. The status call is the
         issue's own contract — a connector adopted from an older generation
         answers with the path IT is writing, which is the file that actually
         holds the account's activity. */
      try {
        const status = JSON.parse(toolText(await call("incoming_feed_status", {}))) as { feed_file?: unknown };
        const feedFile = typeof status?.feed_file === "string" && status.feed_file ? status.feed_file : null;
        return readFeedDialogsSince(feedFile, input.sinceMs);
      } catch {
        /* A feed that cannot be located or read is not a failed run: the
           candidate walk still covers the account, exactly as it did before the
           feed existed. A connector that is actually down fails the walk next,
           which is where a run SHOULD fail. */
        return [];
      }
    },
    async listChats(input) {
      const result = await call("list_chats", { chat_type: input.kind, limit: Math.min(input.limit, CHAT_PAGE_LIMIT) });
      return toolRecords(result)
        .map((record) => chatSummary(record, input.kind))
        .filter((chat): chat is TelegramChatSummary => chat !== null);
    },
    async pageChats(input) {
      const result = await call("get_chats", { page: input.page, page_size: Math.min(input.pageSize, CHAT_PAGE_LIMIT) });
      return toolRecords(result)
        .map((record) => {
          const id = record.chat_id;
          if (typeof id !== "number" && typeof id !== "string") return null;
          return { id: String(id), title: typeof record.title === "string" ? record.title : String(id) };
        })
        .filter((row): row is { id: string; title: string } => row !== null);
    },
    async lastMessageAt(chatId) {
      const result = await call("list_messages", { chat_id: Number(chatId), limit: 1 });
      const record = toolRecords(result)[0];
      const date = record?.date;
      if (typeof date !== "string") return null;
      const parsed = Date.parse(date);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    },
  };
}
