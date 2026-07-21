import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const sessionId = process.env.LLV_FIXTURE_SESSION_ID ?? "";
const deliveryLog = process.env.LLV_FIXTURE_DELIVERY_LOG ?? "";
if (!sessionId || !deliveryLog) throw new Error("recovery fixture configuration is incomplete");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let deliveryCount = 0;

for await (const line of input) {
  if (!line) continue;
  const frame = record(JSON.parse(line));
  const message = record(frame?.message);
  const content = message?.content;
  if (frame?.type !== "user"
    || frame.session_id !== sessionId
    || message?.role !== "user"
    || !Array.isArray(content)) {
    throw new Error("recovery fixture received an invalid user frame");
  }
  const text = content.map((block) => {
    const candidate = record(block);
    return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
  }).join("");
  if (!text.trim()) throw new Error("recovery fixture received an empty user frame");
  deliveryCount += 1;
  const textSha256 = crypto.createHash("sha256").update(text).digest("hex");
  fs.appendFileSync(deliveryLog, `${JSON.stringify({ sessionId, deliveryCount, textSha256 })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "user",
    isReplay: true,
    session_id: sessionId,
    uuid: `fixture-user-${deliveryCount}`,
    message: { role: "user", content },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", content: [{ type: "text", text: "RECOVERY_OK" }] },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sessionId,
  })}\n`);
}
