import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import type { RuntimeEvent } from "./engineHost";
import { FileRuntimeEventStore } from "./eventStore";
import { pathIsInside, prepareCodexIntegrationTestHome } from "./integrationTestHome";

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
const isolatedHome = prepareCodexIntegrationTestHome(codexBinary);

afterAll(() => isolatedHome?.cleanup());

async function waitFor(
  iterator: AsyncIterator<RuntimeEvent>,
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 60_000,
): Promise<RuntimeEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error("Codex event stream ended early");
        if (predicate(next.value)) return next.value;
      }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex integration event timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function containsText(event: RuntimeEvent, expected: string): boolean {
  if (event.kind === "delta") return event.text.includes(expected);
  if (event.kind !== "item") return false;
  const item = event.item as { type?: string; text?: string } | null;
  return item?.type === "agentMessage" && item.text?.includes(expected) === true;
}

test.skipIf(!isolatedHome)("real Codex subscription supports late attach, steering, and restart resume", async () => {
  if (!isolatedHome) throw new Error("isolated Codex subscription home is unavailable");
  const eventStore = new FileRuntimeEventStore(path.join(isolatedHome.directory, "events"));
  let host: CodexAppServerHost | null = null;
  let recovered: CodexAppServerHost | null = null;
  try {
    host = await CodexAppServerHost.start({
      cwd: process.cwd(),
      binary: codexBinary,
      codexHome: isolatedHome.codexHome,
      env: isolatedHome.env,
      fileAuthCredentials: true,
      model: "gpt-5.4-mini",
      sandbox: "read-only",
      approvalPolicy: "never",
      requestTimeoutMs: 60_000,
      eventStore,
    });
    const sessionPath = host.identity.path;
    if (!sessionPath) throw new Error("Codex returned no session file path");
    expect(pathIsInside(isolatedHome.codexHome, sessionPath)).toBeTrue();
    const owner = host.attach(0)[Symbol.asyncIterator]();
    const started = await host.send({
      id: `issue-149-original-${crypto.randomUUID()}`,
      text: "Remember marker ZEBRA-149. Run the shell command `sleep 4`, then reply with exactly ORIGINAL-149. Follow steering received while the command runs.",
    });
    expect(started.outcome).toBe("turn-started");
    const turnId = started.outcome === "turn-started" ? started.turnId : "";
    await waitFor(owner, (event) => event.kind === "item" && event.phase === "started" && (event.item as { type?: string })?.type === "commandExecution");

    const lateClient = host.attach(0)[Symbol.asyncIterator]();
    const steered = await host.send({
      id: `issue-149-steer-${crypto.randomUUID()}`,
      text: "Replace the final response with exactly STEERED-149.",
      expectedTurnId: turnId,
    });
    expect(steered).toEqual({ outcome: "steered", turnId });
    await waitFor(lateClient, (event) => containsText(event, "STEERED-149"));
    await waitFor(owner, (event) => event.kind === "turn-ended" && event.turnId === turnId && event.status === "completed");
    expect(fs.existsSync(sessionPath)).toBeTrue();

    const threadId = host.identity.threadId;
    await host.release();
    const releasedCursor = (await host.health()).eventCursor;
    host = null;
    recovered = await CodexAppServerHost.adopt(threadId, {
      cwd: process.cwd(),
      binary: codexBinary,
      codexHome: isolatedHome.codexHome,
      env: isolatedHome.env,
      fileAuthCredentials: true,
      model: "gpt-5.4-mini",
      sandbox: "read-only",
      approvalPolicy: "never",
      requestTimeoutMs: 60_000,
      initialEventCursor: releasedCursor,
      eventStore,
    });
    expect(recovered.identity.path).toBe(path.resolve(sessionPath));
    expect(pathIsInside(isolatedHome.codexHome, recovered.identity.path ?? "")).toBeTrue();
    const restartReplay = recovered.attach(releasedCursor - 1)[Symbol.asyncIterator]();
    expect((await restartReplay.next()).value).toEqual({ kind: "session-status", status: "unhosted", seq: releasedCursor });
    const recoveredCursor = (await recovered.health()).eventCursor;
    const reconciledIdle = await waitFor(restartReplay, (event) => event.seq === recoveredCursor);
    expect(reconciledIdle).toEqual({ kind: "session-status", status: "idle", seq: recoveredCursor });
    expect(recoveredCursor).toBeGreaterThan(releasedCursor);
    const recoveryEvents = recovered.attach(recoveredCursor)[Symbol.asyncIterator]();
    const recall = await recovered.send({
      id: `issue-149-recall-${crypto.randomUUID()}`,
      text: "Reply with only the marker I asked you to remember.",
    });
    expect(recall.outcome).toBe("turn-started");
    await waitFor(recoveryEvents, (event) => containsText(event, "ZEBRA-149"));
  } finally {
    await host?.release();
    await recovered?.release();
    isolatedHome.cleanup();
  }
}, 180_000);
