/**
 * The pending-question pane for the motion capture: renders the AskUserQuestion
 * menu the way an agent CLI would, so the real /api/answer delivery path —
 * screen verification, arrow-key navigation, Enter, transcript confirmation —
 * works against the fixture. On Enter it records the configured answer in the
 * transcript, which is exactly what a live agent would do.
 *
 * argv: <transcriptPath> <base64 config JSON>
 * config: { question, options: string[], selected: number, answerLines: string[], utimeIso }
 */
const fs = require("node:fs");

const transcriptPath = process.argv[2];
const config = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));

// Keep the transcript open so process discovery sees a running agent.
fs.openSync(transcriptPath, "a");

let highlighted = 0;
let answered = false;

function render() {
  const lines = ["", ` ● ${config.question}`, ""];
  config.options.forEach((label, index) => {
    lines.push(`${index === highlighted ? " ❯ " : "   "}${index + 1}. ${label}`);
  });
  lines.push("", "   ↑/↓ to move · Enter to select");
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`);
}

function renderAnswered() {
  const label = config.options[highlighted];
  process.stdout.write(`\x1b[2J\x1b[H\r\n ● Answered: ${label}\r\n\r\n ❯ `);
}

function recordAnswer() {
  if (answered) return;
  answered = true;
  fs.appendFileSync(transcriptPath, config.answerLines.map((line) => `${line}\n`).join(""), "utf8");
  const instant = new Date(config.utimeIso);
  fs.utimesSync(transcriptPath, instant, instant);
  renderAnswered();
}

function onKey(chunk) {
  const data = chunk.toString("utf8");
  for (let i = 0; i < data.length; i += 1) {
    if (answered) return;
    if (data.startsWith("\x1b[A", i) || data.startsWith("\x1bOA", i)) {
      highlighted = Math.max(0, highlighted - 1);
      i += 2;
      render();
    } else if (data.startsWith("\x1b[B", i) || data.startsWith("\x1bOB", i)) {
      highlighted = Math.min(config.options.length - 1, highlighted + 1);
      i += 2;
      render();
    } else if (data[i] === "\r" || data[i] === "\n") {
      recordAnswer();
    }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", onKey);
render();
setInterval(() => {}, 60_000);
