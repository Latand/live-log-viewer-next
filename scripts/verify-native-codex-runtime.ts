import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const binary = process.argv[2];
if (!binary || !isAbsolute(binary) || !existsSync(binary)) throw new Error("Pass an absolute Codex 0.154.0 fixture executable");
const roots = mkdtempSync(join(tmpdir(), "n-"));
const bin = join(roots, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "bun"));
const env: NodeJS.ProcessEnv = {
  PATH: [bin, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  LANG: "C.UTF-8", NODE_ENV: "test",
  NATIVE_CODEX_QUEUE_TEST_BINARY: binary,
  LLV_CODEX_HISTORY_CLI: binary,
};
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  env[key] = join(roots, key === "TMPDIR" ? "t" : key.toLowerCase()); mkdirSync(env[key]!);
}
const files = [
  "src/lib/runtime/nativeCodexQueue.test.ts",
  "src/lib/runtime/codexHistoryReader.test.ts",
  "src/lib/runtime/nativeQueueRuntime.test.ts",
  "src/lib/runtime/nativeQueueContent.test.ts",
  "src/runtime-host/nativeQueueJournal.test.ts",
  "src/lib/runtime/nativeQueueHost.integration.test.ts",
  "src/lib/runtime/codexTurnProfile.test.ts",
  "src/lib/runtime/codexAppServerHost.test.ts",
  "src/lib/runtime/claudeStreamBrokerHost.test.ts",
  "src/lib/runtime/structuredDeliveryQueue.test.ts",
  "src/lib/runtime/structuredDeliveryController.test.ts",
  "src/lib/runtime/engineHostEvents.test.ts",
  "src/lib/runtime/codex.test.ts",
  "src/lib/runtime/eventStore.test.ts",
  "src/lib/runtime/commands.test.ts",
  "src/lib/runtime/realtimeControl.selectedContext.test.ts",
  "src/lib/runtime/voiceViewBinding.test.ts",
  "src/lib/runtime/voicePersonaRole.test.ts",
  "src/lib/runtime/voicePersonaMandate.test.ts",
  "src/lib/runtime/voiceDelivery.test.ts",
  "src/lib/runtime/voiceStreamChunks.test.ts",
  // #1629 experience stage: the queue the operator touches, and the voice
  // repairs the independent review of the component branch required.
  "src/lib/runtime/codexRealtimeTranscript.test.ts",
  "src/lib/mcp/nativeWorkMetadata.test.ts",
  "src/lib/mcp/voiceUtteranceContext.test.ts",
  "src/lib/mcp/voiceUtteranceWiring.test.ts",
  "src/components/nativeQueueView.test.ts",
];

/**
 * The browser half, run in its own process.
 *
 * Every one of these installs its own happy-dom window over the same globals,
 * and Bun runs a `bun test <files…>` invocation in ONE process — so a DOM file
 * sharing a process with the runtime files above starts inheriting whichever
 * document loaded first. They are a separate spawn for that reason, not because
 * they are optional.
 */
const domFiles = [
  "src/components/NativeQueuePanel.dom.test.tsx",
  "src/components/TmuxComposer.nativeQueue.dom.test.tsx",
  "src/components/VoiceConversation.dom.test.tsx",
  "src/lib/realtime/voiceCardChain.dom.test.ts",
  "src/lib/realtime/voiceCanonicalTranscript.dom.test.ts",
  "src/lib/realtime/codexRealtimeClient.selectedContext.dom.test.ts",
  "src/lib/realtime/codexRealtimeClient.transport.dom.test.ts",
];
for (const file of [...files, ...domFiles]) if (!existsSync(file)) throw new Error(`Missing named native runtime check: ${file}`);
for (const batch of [files, domFiles]) {
  const result = spawnSync(process.execPath, ["test", ...batch], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.exit(0);
