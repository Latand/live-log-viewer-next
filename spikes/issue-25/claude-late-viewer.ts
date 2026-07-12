import type { BrokerMessage } from "./claude-wire";
import { requiredArg } from "./lib";
import { WsInbox } from "./ws-inbox";

const url = requiredArg("--url");
const emit = (event: string, data: unknown) => console.log(JSON.stringify({ event, data }));
const viewer = await WsInbox.connect<BrokerMessage>(`${url}?after=0`);
const hello = await viewer.waitFor((message) => message.kind === "hello");
const replay = hello.replay ?? [];
emit("late_attach", {
  active: hello.active,
  replayCount: replay.length,
  replaySeq: replay.length
    ? [replay[0].seq, replay[replay.length - 1].seq]
    : [],
});
if (!hello.active || replay.length === 0) {
  throw new Error("Late viewer joined without active state and replay history");
}

const mark = viewer.mark();
viewer.send({
  op: "send",
  clientMessageId: "issue-25-claude-injected",
  text: "Reply with exactly INJECTED-OK.",
});
const ack = await viewer.waitFor(
  (message) =>
    message.kind === "send_ack" &&
    message.clientMessageId === "issue-25-claude-injected",
  mark,
);
emit("stdin_injected", ack);
if (ack.disposition !== "queued") throw new Error(`Expected queued injection, got ${ack.disposition}`);

const result = await viewer.waitFor(
  (message) =>
    message.kind === "event" &&
    message.event?.type === "result" &&
    String(message.event?.result ?? "").trim() === "INJECTED-OK",
  mark,
);
const live = viewer.messages.slice(mark).filter((message) => message.kind === "event");
emit("queued_turn_completed", {
  result: result.event?.result,
  liveEventCount: live.length,
  eventTypes: [...new Set(live.map((message) => message.event?.type))],
});
viewer.close();
