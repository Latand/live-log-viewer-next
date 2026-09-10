import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { serveRuntimeHost } from "./socket";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { parseRuntimeCommand } from "@/lib/runtime/commands";

// Real socket framing and journal reopen, with no engine process or shared state.
test("native queue journal preserves mutation identity and content through the production socket and reopen", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nqs-"));
  const filename = path.join(base, "journal.sqlite");
  const socket = path.join(base, "host.sock");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({ scope: "session:conversation_socket", kind: "session-status", payload: {
    conversationId: "conversation_socket", sessionKey: { engine: "codex", sessionId: "thread-socket" },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", accountId: null,
    capabilities: { steer: true, nativeQueue: true, structuredAttention: true },
  } });
  const server = serveRuntimeHost(socket, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socket);
  try {
    const command = parseRuntimeCommand("native-queue", { conversationId: "conversation_socket", operationId: "op-socket", idempotencyKey: "socket-key",
      action: "add", binding: { threadId: "thread-socket", accountId: null }, text: "Привіт 🌍", runtime: { serviceTierForTurn: "priority" } });
    expect((await client.command(command)).receipt.status).toBe("queued");
    const input = [{ type: "text" as const, text: "Привіт 🌍" }];
    await client.nativeQueueTransition("op-socket", { phase: "prepared", input });
    await expect(client.nativeQueueTransition("op-socket", { phase: "prepared", input })).rejects.toThrow("moved");
    await client.nativeQueueTransition("op-socket", { phase: "uncertain", reason: "fixture lost acknowledgement" });
    expect((await client.nativeQueueRead("conversation_socket"))[0]).toMatchObject({ state: "uncertain", versions: [{ input, requestedRuntime: { serviceTierForTurn: "priority" } }] });
    expect((await client.command(command)).replayed).toBeTrue();
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    journal.close();
  }
  const reopened = new RuntimeJournal(filename, { structuredHosts: true });
  expect(reopened.nativeQueueRead("conversation_socket")[0]).toMatchObject({ mutationOperationId: "op-socket", state: "uncertain", proof: null });
  expect(reopened.operationResult("op-socket")?.receipt.status).toBe("uncertain");
  reopened.close();
});
