import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";
import { tmuxServerPid } from "@/lib/tmux";

const state = process.env.LLV_E2E_STATE || path.join(process.cwd(), ".llv-e2e-viewer-replacement.json");
const command = process.argv[2];

if (command === "prepare") {
  const root = process.argv[process.argv.indexOf("--root") + 1];
  if (!root || !fs.existsSync(root)) throw new Error("prepare requires --root <existing transcript>");
  const serverPid = await tmuxServerPid();
  const snapshot = { root, tmux: serverPid ? { pid: serverPid, identity: procBackend.processIdentity(serverPid) } : null, preparedAt: new Date().toISOString() };
  fs.writeFileSync(state, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ mode: "prepare", dryRun: true, snapshot }, null, 2));
} else if (command === "verify") {
  const snapshot = JSON.parse(fs.readFileSync(state, "utf8")) as { root: string; tmux: { pid: number; identity: string | null } | null };
  const currentPid = await tmuxServerPid();
  const currentIdentity = currentPid ? procBackend.processIdentity(currentPid) : null;
  const stable = snapshot.tmux !== null && snapshot.tmux.identity !== null && snapshot.tmux.identity === currentIdentity;
  console.log(JSON.stringify({ mode: "verify", dryRun: true, rootStillExists: fs.existsSync(snapshot.root), tmuxStable: stable, expected: snapshot.tmux, current: currentPid ? { pid: currentPid, identity: currentIdentity } : null }, null, 2));
  if (!stable || !fs.existsSync(snapshot.root)) process.exitCode = 1;
} else {
  throw new Error("use prepare --root <transcript> or verify");
}
