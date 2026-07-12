import {
  CodexRpcClient,
  codexEventSummary,
  codexNotificationText,
  type SteerResult,
  type ThreadResult,
} from "./codex-rpc";
import { requiredArg } from "./lib";

const url = requiredArg("--url");
const threadId = requiredArg("--thread");
const turnId = requiredArg("--turn");

const emit = (event: string, data: unknown) => {
  console.log(JSON.stringify({ event, data }));
};

const client = await CodexRpcClient.connect(url, "llv_issue_25_late_viewer");
const mark = client.mark();
const resumed = await client.request<ThreadResult>("thread/resume", { threadId });
const turns = resumed.thread?.turns ?? resumed.thread?.initialTurnsPage?.data ?? [];
emit("late_attach", {
  threadId,
  runtimeStatus: resumed.thread?.status,
  replayedTurns: turns.length,
});

const steered = await client.request<SteerResult>("turn/steer", {
  threadId,
  expectedTurnId: turnId,
  input: [{ type: "text", text: "Replace the final response with exactly STEERED-OK." }],
  clientUserMessageId: "issue-25-codex-steer",
});
emit("steer_accepted", { requestedTurnId: turnId, acceptedTurnId: steered.turnId });

const completed = await client.waitFor(
  (message) =>
    message.method === "turn/completed" && message.params?.turn?.id === turnId,
  mark,
);
const liveEvents = client.notifications.slice(mark);
const text = codexNotificationText(liveEvents);
emit("live_events_seen", {
  eventCount: liveEvents.length,
  methods: [...new Set(liveEvents.map((message) => message.method))],
  text,
});
if (!text.includes("STEERED-OK")) {
  throw new Error(`Later client missed steered output; methods=${liveEvents.map((item) => item.method)}`);
}
emit("same_turn_completed", codexEventSummary(completed));
client.close();
