import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import { NextRequest } from "next/server";

/* #1652: a queued message carries general files the way an ordinary send does —
   bytes in the viewer inbox under a batch derived from the original key, paths
   in the queued text. The suite owns its config root, so every attachment it
   writes lands in a private inbox and never in the operator's (AGENTS.md); the
   fixtures are invented bytes. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-queue-files-"));
const previous = {
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.LLV_STATE_DIR,
  staging: process.env.LLV_STAGING,
};
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, "config");
process.env.LLV_STATE_DIR = path.join(home, "state");
delete process.env.LLV_STAGING;
afterAll(() => {
  for (const [key, value] of [
    ["HOME", previous.home],
    ["XDG_CONFIG_HOME", previous.xdg],
    ["LLV_STATE_DIR", previous.state],
    ["LLV_STAGING", previous.staging],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const { RuntimeJournal } = await import("@/runtime-host/journal");
const { handleNativeQueue } = await import("./nativeQueueHttp");
const { inboxFileBatchToken, inboxFilesDir } = await import("@/lib/inboxFiles");
const { MAX_INBOX_FILES } = await import("@/lib/filePolicy");
type RuntimeHostClient = import("./client").RuntimeHostClient;
type NativeQueueCommand = import("./nativeQueueContracts").NativeQueueCommand;
type RuntimeJournalType = InstanceType<typeof RuntimeJournal>;

const conversationId = "conversation_queue_files";
const binding = { threadId: "thread-files", accountId: "account-a" };

function makeJournal(): RuntimeJournalType {
  const journal = new RuntimeJournal(":memory:", { structuredHosts: true });
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
    host: "hosted", turn: "running", activeTurnId: "active-a", accountId: binding.accountId,
    capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
  } });
  return journal;
}

/** The journal behind the socket, with the two ways a transport can fail. */
function clientFor(journal: RuntimeJournalType, fault: { before?: boolean; after?: boolean } = {}): RuntimeHostClient {
  return {
    command: async (command: NativeQueueCommand) => {
      if (fault.before) throw new Error("runtime host socket closed");
      const result = journal.executeOperation(command);
      if (fault.after) throw new Error("runtime host socket closed");
      return result;
    },
    nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
  } as unknown as RuntimeHostClient;
}

const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0x0d, 0x0a, 0x1a, 0xfe]);
const attachment = (name: string, data: Buffer) => ({ name, base64: data.toString("base64") });

function post(body: Record<string, unknown>, journal: RuntimeJournalType, fault?: { before?: boolean; after?: boolean }) {
  return handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  }), {
    client: () => clientFor(journal, fault), enabled: () => true, kick: () => {},
    admitImages: () => ({ images: [], error: null }), storeImages: () => [],
  });
}

const add = (key: string, extra: Record<string, unknown> = {}) => ({
  conversationId, idempotencyKey: key, action: "add", text: "read the attached trace", binding, ...extra,
});
const batchDir = (key: string) => path.join(inboxFilesDir(), inboxFileBatchToken(key));
const inboxEntries = () => (fs.existsSync(inboxFilesDir()) ? fs.readdirSync(inboxFilesDir()) : []);

beforeEach(() => { fs.rmSync(inboxFilesDir(), { recursive: true, force: true }); });

test("a queued message carries its files as inbox paths in the queued text", async () => {
  const journal = makeJournal();
  const response = await post(add("queue-files", { files: [attachment("trace.bin", binary), attachment("notes.txt", Buffer.from("invented notes"))] }), journal);
  expect(response.status).toBe(202);
  expect((await response.json()).receipt.status).toBe("queued");
  const dir = batchDir("queue-files");
  const paths = [path.join(dir, "trace.bin"), path.join(dir, "notes.txt")];
  expect(fs.readFileSync(paths[0]!).equals(binary)).toBeTrue();
  expect(fs.readFileSync(paths[1]!, "utf8")).toBe("invented notes");
  const [entry] = journal.nativeQueueRead(conversationId);
  expect(entry?.versions[0]?.text).toBe(["read the attached trace", ...paths].join("\n"));
  journal.close();
});

test("a files-only message is a message, and its text is the paths", async () => {
  const journal = makeJournal();
  const response = await post(add("files-only", { text: "", files: [attachment("trace.bin", binary)] }), journal);
  expect(response.status).toBe(202);
  expect(journal.nativeQueueRead(conversationId)[0]?.versions[0]?.text).toBe(path.join(batchDir("files-only"), "trace.bin"));
  journal.close();
});

test("a replay of the original key is the same operation and leaves the accepted file untouched", async () => {
  const journal = makeJournal();
  const body = add("queue-replay", { files: [attachment("trace.bin", binary)] });
  const first = await (await post(body, journal)).json();
  const file = path.join(batchDir("queue-replay"), "trace.bin");
  const before = fs.statSync(file);
  const replay = await post(body, journal);
  expect(replay.status).toBe(202);
  const answer = await replay.json();
  expect(answer.operationId).toBe(first.operationId);
  expect(answer.replayed).toBeTrue();
  expect(fs.statSync(file).ino).toBe(before.ino);
  expect(fs.readFileSync(file).equals(binary)).toBeTrue();
  expect(journal.nativeQueueRead(conversationId)).toHaveLength(1);
  journal.close();
});

test("a lost answer keeps the file, and the replay finds the operation the journal committed", async () => {
  const journal = makeJournal();
  const body = add("queue-lost", { files: [attachment("trace.bin", binary)] });
  const lost = await post(body, journal, { after: true });
  expect(lost.status).toBe(503);
  const file = path.join(batchDir("queue-lost"), "trace.bin");
  expect(fs.readFileSync(file).equals(binary)).toBeTrue();
  const replay = await post(body, journal);
  expect(replay.status).toBe(202);
  expect((await replay.json()).replayed).toBeTrue();
  expect(journal.nativeQueueRead(conversationId)).toHaveLength(1);
  expect(fs.readFileSync(file).equals(binary)).toBeTrue();
  journal.close();
});

test("a transport that fails before the journal keeps the file, since the Viewer cannot tell", async () => {
  const journal = makeJournal();
  const unknown = await post(add("queue-unknown", { files: [attachment("trace.bin", binary)] }), journal, { before: true });
  expect(unknown.status).toBe(503);
  expect(fs.existsSync(path.join(batchDir("queue-unknown"), "trace.bin"))).toBeTrue();
  expect(journal.nativeQueueRead(conversationId)).toEqual([]);
  journal.close();
});

test("the original key with different bytes is refused without touching the accepted file", async () => {
  const journal = makeJournal();
  await post(add("queue-owned", { files: [attachment("trace.bin", binary)] }), journal);
  const file = path.join(batchDir("queue-owned"), "trace.bin");
  const conflict = await post(add("queue-owned", { files: [attachment("trace.bin", Buffer.from("other bytes"))] }), journal);
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error).toContain("different contents");
  expect(fs.readFileSync(file).equals(binary)).toBeTrue();
  expect(journal.nativeQueueRead(conversationId)).toHaveLength(1);
  journal.close();
});

test("an idempotency conflict releases only the file it created, never the accepted one beside it", async () => {
  const journal = makeJournal();
  await post(add("queue-shared", { files: [attachment("trace.bin", binary)] }), journal);
  const conflict = await post(add("queue-shared", { files: [attachment("trace.bin", binary), attachment("extra.txt", Buffer.from("extra"))] }), journal);
  expect(conflict.status).toBe(409);
  expect(fs.readdirSync(batchDir("queue-shared"))).toEqual(["trace.bin"]);
  expect(fs.readFileSync(path.join(batchDir("queue-shared"), "trace.bin")).equals(binary)).toBeTrue();
  journal.close();
});

test("a stale binding is refused under its frozen key, and its files go with it", async () => {
  const journal = makeJournal();
  const refused = await post(add("queue-stale", { binding: { ...binding, accountId: "account-b" }, files: [attachment("trace.bin", binary)] }), journal);
  expect(refused.status).toBe(409);
  expect((await refused.json()).receipt).toMatchObject({ status: "rejected", reason: "stale-generation" });
  expect(fs.existsSync(batchDir("queue-stale"))).toBeFalse();
  journal.close();
});

test("invalid files refuse the whole admission with the reason, writing nothing", async () => {
  const journal = makeJournal();
  const cases: Array<[unknown, number, string]> = [
    [[{ name: "trace.bin", base64: "!!!" }], 400, "could not be read"],
    [[{ name: "trace.bin" }], 400, "invalid file"],
    ["trace.bin", 400, "files must be an array"],
    [Array.from({ length: MAX_INBOX_FILES + 1 }, (_, index) => attachment(`f${index}.bin`, binary)), 413, "too many files"],
  ];
  for (const [files, status, reason] of cases) {
    const response = await post(add(`queue-invalid-${status}-${reason.length}`, { files }), journal);
    expect(response.status).toBe(status);
    expect((await response.json()).error).toContain(reason);
  }
  const missingKey = await post({ ...add("unused"), idempotencyKey: undefined, files: [attachment("trace.bin", binary)] }, journal);
  expect(missingKey.status).toBe(400);
  expect(inboxEntries()).toEqual([]);
  expect(journal.nativeQueueRead(conversationId)).toEqual([]);
  journal.close();
});

test("a control that names files is refused instead of dropping them", async () => {
  const journal = makeJournal();
  const response = await post({ conversationId, idempotencyKey: "queue-delete", action: "delete", entryId: "queue-x",
    expectedRevision: 1, binding, files: [attachment("trace.bin", binary)] }, journal);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("message or an edit");
  expect(inboxEntries()).toEqual([]);
  journal.close();
});

/** What the executor does once Codex holds a mutation: the entry is queued again
    and open to the next edit. */
async function acknowledge(journal: RuntimeJournalType, response: Response): Promise<void> {
  const { operationId } = await response.json();
  const entry = journal.nativeQueueRead(conversationId)[0]!;
  journal.nativeQueueTransition(operationId, { phase: "prepared", input: [{ type: "text", text: entry.versions.at(-1)!.text }] });
  journal.nativeQueueTransition(operationId, { phase: "acknowledged", nativeSubmissionId: "native-1" });
}

test("an edit keeps the files its words name and may carry new ones under its own key", async () => {
  const journal = makeJournal();
  await acknowledge(journal, await post(add("queue-edit-add", { files: [attachment("trace.bin", binary)] }), journal));
  const [queued] = journal.nativeQueueRead(conversationId);
  const original = queued!.versions[0]!.text;
  /* What the panel sends: the version's text, edited. The path is part of it. */
  const words = await post({ conversationId, idempotencyKey: "queue-edit-words", action: "update", entryId: queued!.entryId,
    expectedRevision: 1, binding, text: original.replace("read the attached trace", "read the trace first") }, journal);
  expect(words.status).toBe(202);
  await acknowledge(journal, words);
  const revision2 = journal.nativeQueueRead(conversationId)[0]!.versions.at(-1)!;
  expect(revision2.text).toContain(path.join(batchDir("queue-edit-add"), "trace.bin"));
  expect(revision2.text.startsWith("read the trace first\n")).toBeTrue();
  const more = await post({ conversationId, idempotencyKey: "queue-edit-files", action: "update", entryId: queued!.entryId,
    expectedRevision: 2, binding, text: revision2.text, files: [attachment("notes.txt", Buffer.from("invented notes"))] }, journal);
  expect(more.status).toBe(202);
  await acknowledge(journal, more);
  const revision3 = journal.nativeQueueRead(conversationId)[0]!.versions.at(-1)!;
  expect(revision3.text).toBe(`${revision2.text}\n${path.join(batchDir("queue-edit-files"), "notes.txt")}`);
  /* A stale edit is refused, and only its own file is released. */
  const stale = await post({ conversationId, idempotencyKey: "queue-edit-stale", action: "update", entryId: queued!.entryId,
    expectedRevision: 1, binding, text: "stale", files: [attachment("late.txt", Buffer.from("late"))] }, journal);
  expect(stale.status).toBe(409);
  expect(fs.existsSync(batchDir("queue-edit-stale"))).toBeFalse();
  expect(fs.readFileSync(path.join(batchDir("queue-edit-add"), "trace.bin")).equals(binary)).toBeTrue();
  expect(fs.readFileSync(path.join(batchDir("queue-edit-files"), "notes.txt"), "utf8")).toBe("invented notes");
  journal.close();
});

/** The journal behind a socket whose FIRST command waits at the door until the
    test lets it through, and may then fail the way `fail` says. */
function heldClient(journal: RuntimeJournalType, fail?: string) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const order: string[] = [];
  let calls = 0;
  const client = {
    command: async (command: NativeQueueCommand & { text?: string }) => {
      const first = ++calls === 1;
      order.push(command.text?.split("\n")[0] ?? "");
      if (first) {
        reached();
        await gate;
        if (fail) throw new Error(fail);
      }
      return journal.executeOperation(command);
    },
    nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
  } as unknown as RuntimeHostClient;
  const send = (body: Record<string, unknown>) => handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { client: () => client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [] });
  return { send, release, arrived, order };
}

test("a request refused under the key another request was admitted with never deletes the file that one names", async () => {
  const journal = makeJournal();
  const held = heldClient(journal);
  const files = [attachment("trace.bin", binary)];
  const first = held.send(add("queue-race", { text: "first words", files }));
  await held.arrived;
  /* Same key, same bytes, different words: a second request while the first
     is still waiting for the journal. */
  const second = held.send(add("queue-race", { text: "second words", files }));
  await Bun.sleep(20);
  const reachedWhileHeld = [...held.order];
  held.release();
  const [firstAnswer, secondAnswer] = await Promise.all([first, second]);
  const file = path.join(batchDir("queue-race"), "trace.bin");
  expect(fs.existsSync(file) && fs.readFileSync(file).equals(binary)).toBeTrue();
  expect(reachedWhileHeld).toEqual(["first words"]);
  expect(firstAnswer.status).toBe(202);
  expect(secondAnswer.status).toBe(409);
  const entries = journal.nativeQueueRead(conversationId);
  expect(entries.map((entry) => entry.versions[0]!.text)).toEqual([`first words\n${file}`]);
  journal.close();
});

test("a refusal that releases its file finishes before a request under the same key reuses it", async () => {
  const journal = makeJournal();
  const held = heldClient(journal, "native queue entry revision changed");
  const files = [attachment("trace.bin", binary)];
  const first = held.send(add("queue-race-refused", { text: "first words", files }));
  await held.arrived;
  const second = held.send(add("queue-race-refused", { text: "second words", files }));
  await Bun.sleep(20);
  held.release();
  const [firstAnswer, secondAnswer] = await Promise.all([first, second]);
  const file = path.join(batchDir("queue-race-refused"), "trace.bin");
  /* The admitted request's file is there, whole, whatever the refused one released. */
  expect(fs.existsSync(file) && fs.readFileSync(file).equals(binary)).toBeTrue();
  expect(firstAnswer.status).toBe(409);
  expect(secondAnswer.status).toBe(202);
  expect(held.order).toEqual(["first words", "second words"]);
  expect(journal.nativeQueueRead(conversationId).map((entry) => entry.versions[0]!.text)).toEqual([`second words\n${file}`]);
  journal.close();
});

test("requests under different keys do not wait for each other", async () => {
  const journal = makeJournal();
  const held = heldClient(journal);
  const first = held.send(add("queue-slow", { text: "slow", files: [attachment("trace.bin", binary)] }));
  await held.arrived;
  const quick = await held.send(add("queue-quick", { text: "quick", files: [attachment("trace.bin", binary)] }));
  expect(quick.status).toBe(202);
  held.release();
  expect((await first).status).toBe(202);
  journal.close();
});

test("a replay after the message was delivered answers the delivered receipt and keeps the file", async () => {
  const journal = makeJournal();
  const body = add("queue-delivered", { files: [attachment("trace.bin", binary)] });
  const { operationId } = await (await post(body, journal)).json();
  const [entry] = journal.nativeQueueRead(conversationId);
  const input = [{ type: "text" as const, text: entry!.versions[0]!.text }];
  journal.nativeQueueTransition(operationId, { phase: "prepared", input });
  journal.nativeQueueTransition(operationId, { phase: "acknowledged", nativeSubmissionId: "native-1" });
  journal.nativeQueueTransition(operationId, { phase: "proven", proof: { threadId: binding.threadId,
    clientUserMessageId: entry!.clientUserMessageId, revision: 1, turnId: "turn-1", itemId: "item-1", input } });
  const replay = await post(body, journal);
  expect(replay.status).toBe(202);
  expect((await replay.json()).receipt.status).toBe("delivered");
  expect(fs.readFileSync(path.join(batchDir("queue-delivered"), "trace.bin")).equals(binary)).toBeTrue();
  journal.close();
});
