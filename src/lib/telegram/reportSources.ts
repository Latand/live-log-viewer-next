import { readTelegramSession } from "./sessionStore";
import { connectorFeedCoverageSince } from "./connector";
import { telegramMcpUrl } from "./packaging";
import { validTelegramAccountId, type TelegramAccountIdentity } from "./contracts";
import { readFeedDialogsSince, scopedFeedFile, type FeedDialog } from "./reportFeed";
import type { TelegramReportGroup } from "./reportContracts";

/**
 * Source discovery for a Daily Report run (issues #1086, #1091, #1128).
 *
 * THE FEED IS THE SOURCE OF INCOMING ACTIVITY SINCE THE LAST RUN. The connector
 * records every settled incoming private burst to its event feed the moment it
 * happens (`reportFeed.ts`), so incoming dialogs are read from that file in one
 * bounded pass, with no dependence on any list order. A dialog ranked dead last
 * by the connector's chat listing is exactly as visible as the first one.
 *
 * The candidate WALK supplies direction-neutral coverage. The feed knows only
 * what arrived while the connector was running and listening: a dialog where
 * the operator did the writing, or one that was active before this connector
 * generation started, has no feed line. The walk runs over every enumerated
 * candidate the feed has not already accounted for and decides by LAST MESSAGE
 * DATE. Position never decides selection.
 *
 * The walk is a SUPPLEMENT and never a substitute. A run whose connector is
 * not running a feed at all fails (`sources_failed`) instead of quietly
 * walking alone: the walk is bounded by a probe budget over a list ordered by
 * pins and folders, so falling back to it silently would hand the operator a
 * report that omits whatever sat past the budget and say nothing about it —
 * the v1 defect this issue exists to end. The supervisor keeps that rare:
 * a connector without the feed is not adopted (`connector.ts`).
 *
 * A feed that is RUNNING is still not automatically a feed that covers the
 * window: a listener started this morning knows nothing about last night, and
 * on the first day after a connect it knows nothing about the window at all.
 * A complete plan needs incoming coverage from the feed plus outgoing coverage
 * from the walk. A mature feed lets the walk spend the enumeration's full
 * bounded surface; a younger feed retains the smaller ordinary probe ceiling.
 * Any exhausted probe budget or truncated enumeration fails the pass.
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
 * time. The ordinary walk stops at {@link MAX_PROBES}; a feed covering the
 * window raises the ceiling only to the already bounded enumeration surface so
 * outgoing-only dialogs receive the same coverage as incoming dialogs. Every
 * candidate inside the applicable ceiling is probed. An earlier revision also
 * stopped after a run of consecutive stale candidates,
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
      after `sinceMs`, newest first, with the earliest instant that feed can
      vouch for (#1091). No dialogs is an answer — a feed that is running and
      has seen nothing — but `coveredSinceMs` later than the window start says
      the answer is only about part of it. Both THROW when the connector is not
      running a feed at all, or when its file cannot be read safely: a report
      whose recency source is missing is a failed run, not a quietly narrower
      one. */
  feedDialogs(input: { sinceMs: number }): Promise<{ dialogs: FeedDialog[]; coveredSinceMs: number | null }>;
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
/** Hard ceiling on single-message probes while the feed covers only part of
    the report window. */
export const MAX_PROBES = 150;
/** Mature-feed ceiling for the direction-neutral residual walk. It equals the
    already bounded enumeration surface, so every enumerated dialog can be
    checked for operator-sent activity while connector reads remain finite. */
export const MAX_MATURE_FEED_PROBES = MAX_CHAT_PAGES * CHAT_PAGE_LIMIT;
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
      candidates. Complete plans keep this false; an exhausted walk fails the
      source pass before persistence. */
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
async function candidateDialogs(
  port: TelegramReadPort,
): Promise<{ candidates: Array<{ id: string; title: string }>; truncated: boolean }> {
  const typed = await port.listChats({ kind: "user", limit: CHAT_PAGE_LIMIT });
  const seen = new Set<string>();
  const candidates: Array<{ id: string; title: string }> = [];
  let truncated = false;
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
    /* A full last page means the dialog list did not end where the walk did:
       whatever sits below it was never even enumerated, which the caller must
       know before it calls this enumeration complete (#1091). */
    if (page === MAX_CHAT_PAGES) truncated = true;
  }
  return { candidates, truncated };
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
 *     applicable probe budget runs out, carried when its last message falls in
 *     the window. A mature feed raises the budget to the bounded enumeration
 *     surface because its journal contains incoming activity only. Position
 *     never decides whether a dialog is LOOKED at; the date decides whether it
 *     is CARRIED.
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
  for (const dialog of fromFeed.dialogs) {
    if (carried.has(dialog.id)) continue;
    carried.add(dialog.id);
    active.push({ id: dialog.id, title: dialog.title, lastMessageAt: dialog.lastMessageAt });
  }
  /* Sequential on purpose: see the module comment. */
  const enumerated = await candidateDialogs(port);
  const candidates = enumerated.candidates.filter((chat) => !carried.has(chat.id));
  const feedCoversIncomingWindow = fromFeed.coveredSinceMs !== null && fromFeed.coveredSinceMs <= windowStart;
  const probeLimit = feedCoversIncomingWindow ? MAX_MATURE_FEED_PROBES : MAX_PROBES;
  let probes = 0;
  for (const chat of candidates) {
    if (probes >= probeLimit) break;
    /* Sequential on purpose: see the module comment. */
    const at = await port.lastMessageAt(chat.id);
    probes += 1;
    const instant = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(instant) || instant < windowStart) continue;
    active.push({ id: chat.id, title: chat.title, lastMessageAt: new Date(instant).toISOString() });
  }
  active.sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
  const probeBudgetExhausted = probes >= probeLimit && candidates.length > probes;
  /* The completeness bar, and the reason a plan may not be returned at all.
     The FEED covers settled incoming activity from its coverage instant. The
     WALK covers operator-sent activity only when it reaches every candidate.
     A mature feed therefore grants the walk the full bounded enumeration
     surface. A truncated enumeration still leaves outgoing activity unknown,
     and a younger feed cannot fill either direction past the ordinary probe
     ceiling. Both conditions fail the source pass and record `sources_failed`;
     the next run's window still covers the day it missed. */
  if (probeBudgetExhausted || enumerated.truncated) {
    throw new Error("Telegram report sources cannot cover this window");
  }
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
    probeBudgetExhausted,
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
 *
 * EVERY read on one port instance is bound to ONE credential generation
 * (#1091). A source pass is tens of seconds of sequential reads, and the
 * operator can log out and connect a second account inside that minute: the
 * token is re-read per call, so without this the same pass would verify
 * account A through `get_me` and then take account B's feed, listings and
 * probes as A's sources — one plan naming two people's correspondents, with
 * the id check already passed. A generation that has moved on FAILS the read
 * instead, which settles the run rather than reporting on the wrong account.
 *
 * `credentialRef` is the generation the caller verified. A caller that
 * verified none — the operator's own group picker, one action, no account
 * check behind it — passes `null` and the port pins itself to the generation
 * of its first read, which keeps that single pass internally consistent.
 */
export function connectorReadPort(credentialRef: string | null = null): TelegramReadPort {
  let pinned = credentialRef;
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const session = readTelegramSession();
    if (!session) throw new Error("Telegram is not connected");
    pinned ??= session.credentialRef;
    /* One fixed sentence: nothing about which generations these were belongs
       in an error a caller may log. */
    if (session.credentialRef !== pinned) throw new Error("Telegram credential generation changed");
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
      /* Two reads, in this order, never overlapping: ask the connector whether
         it is running a feed and where, then read that file locally. The
         status call is the issue's own contract, and it answers with the path
         THIS connector is writing, which is the file that actually holds the
         account's activity.

         A connector that is not running a feed — one adopted from a Viewer
         generation that predates it above all — a connector writing a feed
         that belongs to a DIFFERENT credential generation, and a feed file
         that exists but cannot be read through the owner-only fence are all
         FAILURES here, not empty answers. Returning nothing would put the run
         back on the bounded probe walk alone, silently, which is the exact
         defect #1091 replaced: the operator would get a report that quietly
         omits whatever sat past the probe budget. The failure settles the
         run `sources_failed` instead, and the connector is re-ensured (with
         the feed) by the next health check. */
      let feedFile: string | null = null;
      try {
        const status = toolText(await call("incoming_feed_status", {}));
        /* After the call, so the pin is the generation the read authenticated
           as rather than one this line re-read for itself. */
        feedFile = scopedFeedFile(status, pinned);
      } catch {
        /* Falls through to the one sanitized sentence below. */
      }
      /* One fixed sentence: the upstream error may carry connector text, and
         nothing from it belongs in a caught-and-logged failure. */
      if (!feedFile) throw new Error("Telegram incoming feed is unavailable");
      /* Outside the catch on purpose: the file read's own refusals — an
         owner-only fence failure, a window too large for one bounded read —
         are already sanitized, and each says something different about why the
         run has no recency source. */
      const dialogs = readFeedDialogsSince(feedFile, input.sinceMs);
      /* What this feed can VOUCH for, which the file cannot say about itself:
         a listener started this morning holds nothing about last night, and
         the caller decides whether the walk behind it covered that stretch
         (#1091). */
      return { dialogs, coveredSinceMs: pinned === null ? null : connectorFeedCoverageSince(pinned) };
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
