import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

/* Issue #1224: a general attachment rides the SAME road images already take —
   bytes land in the viewer inbox, the agent gets a path. These tests own the
   disk half of that road, so they run against an isolated config root and never
   the operator's live inbox. Fixtures are invented bytes, never a real file. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-inbox-files-"));
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

const { MAX_INBOX_FILE_BYTES, MAX_INBOX_FILES, MAX_INBOX_FILES_TOTAL_BYTES, inboxAttachmentName } =
  await import("./filePolicy");
const { admitInboxFilePayload, buildFilePayload, deleteInboxFiles, inboxFileBatchToken, inboxFilesDir } =
  await import("./inboxFiles");
const INBOX_FILES_DIR = inboxFilesDir();

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const upload = (name: string, body: string) => ({ name, base64: b64(body) });

test("a plain document is admitted, written to the inbox and referenced by its original filename", () => {
  const admitted = admitInboxFilePayload({ files: [upload("quarterly-notes.pdf", "invented pdf bytes")] });
  expect(admitted.error).toBeNull();
  expect(admitted.files).toHaveLength(1);

  const token = inboxFileBatchToken("client-message-one");
  const bundle = buildFilePayload("read the attached notes", admitted.files, token);
  expect(bundle.filePaths).toHaveLength(1);
  const written = bundle.filePaths[0]!;
  /* The original filename survives intact — the agent is told what it is. */
  expect(path.basename(written)).toBe("quarterly-notes.pdf");
  expect(written.startsWith(INBOX_FILES_DIR + path.sep)).toBe(true);
  expect(fs.readFileSync(written, "utf8")).toBe("invented pdf bytes");
  /* The delivered message carries the path after the text, exactly like images. */
  expect(bundle.payload).toBe(`read the attached notes\n${written}`);

  deleteInboxFiles(bundle.filePaths);
});

test("a text-free send still delivers the attachment path", () => {
  const admitted = admitInboxFilePayload({ files: [upload("trace.log", "invented log line")] });
  const bundle = buildFilePayload("", admitted.files, inboxFileBatchToken("client-message-textless"));
  expect(bundle.payload).toBe(bundle.filePaths[0]);
  deleteInboxFiles(bundle.filePaths);
});

test("replaying one send's batch token rewrites the same path instead of orphaning a copy", () => {
  const files = admitInboxFilePayload({ files: [upload("report.csv", "a,b,c")] }).files;
  const token = inboxFileBatchToken("client-message-replay");
  const first = buildFilePayload("hi", files, token);
  const second = buildFilePayload("hi", files, inboxFileBatchToken("client-message-replay"));
  expect(second.filePaths).toEqual(first.filePaths);
  expect(fs.readdirSync(path.dirname(first.filePaths[0]!))).toEqual(["report.csv"]);
  deleteInboxFiles(first.filePaths);
});

test("an oversized file is refused with an explicit reason and nothing is written", () => {
  const oversize = Buffer.alloc(MAX_INBOX_FILE_BYTES + 1, 7).toString("base64");
  const admitted = admitInboxFilePayload({ files: [{ name: "huge.bin", base64: oversize }] });
  expect(admitted.files).toHaveLength(0);
  expect(admitted.error?.status).toBe(413);
  expect(admitted.error?.error).toContain("too large");
  expect(fs.existsSync(INBOX_FILES_DIR) ? fs.readdirSync(INBOX_FILES_DIR) : []).toEqual([]);
});

test("too many files, and too many bytes across them, are each refused by name", () => {
  const many = Array.from({ length: MAX_INBOX_FILES + 1 }, (_, index) => upload(`note-${index}.txt`, "x"));
  const tooMany = admitInboxFilePayload({ files: many });
  expect(tooMany.error?.status).toBe(413);
  expect(tooMany.error?.error).toContain(String(MAX_INBOX_FILES));

  const chunk = Math.floor(MAX_INBOX_FILES_TOTAL_BYTES / 2) + 1;
  const heavy = Array.from({ length: 2 }, (_, index) => ({
    name: `half-${index}.bin`,
    base64: Buffer.alloc(chunk, 3).toString("base64"),
  }));
  const tooHeavy = admitInboxFilePayload({ files: heavy });
  expect(tooHeavy.error?.status).toBe(413);
  expect(tooHeavy.files).toHaveLength(0);
});

test("a malformed or empty attachment is refused rather than written as zero bytes", () => {
  expect(admitInboxFilePayload({ files: "not an array" }).error?.status).toBe(400);
  expect(admitInboxFilePayload({ files: [{ name: "x.txt" }] }).error?.status).toBe(400);
  expect(admitInboxFilePayload({ files: [{ name: "x.txt", base64: "" }] }).error?.status).toBe(400);
  expect(admitInboxFilePayload({ files: [{ name: "x.txt", base64: "not*base64" }] }).error?.status).toBe(400);
  expect(admitInboxFilePayload({}).files).toEqual([]);
});

test("a hostile filename cannot escape the inbox batch directory", () => {
  expect(inboxAttachmentName("../../etc/passwd")).toBe("passwd");
  expect(inboxAttachmentName("..")).toBe("attachment");
  expect(inboxAttachmentName("")).toBe("attachment");
  expect(inboxAttachmentName("notes with spaces.txt")).toBe("notes_with_spaces.txt");
  /* Non-Latin filenames are kept — the operator's own files are named in them. */
  expect(inboxAttachmentName("звіт.pdf")).toBe("звіт.pdf");

  const admitted = admitInboxFilePayload({ files: [{ name: "../../escape.sh", base64: b64("echo invented") }] });
  const bundle = buildFilePayload("", admitted.files, inboxFileBatchToken("client-message-escape"));
  const written = bundle.filePaths[0]!;
  expect(written.startsWith(INBOX_FILES_DIR + path.sep)).toBe(true);
  expect(path.basename(written)).toBe("escape.sh");
  expect(path.relative(INBOX_FILES_DIR, written).split(path.sep)).toHaveLength(2);
  deleteInboxFiles(bundle.filePaths);
});

test("cleanup removes the bytes and the batch directory they were alone in", () => {
  const admitted = admitInboxFilePayload({ files: [upload("draft.md", "# invented")] });
  const bundle = buildFilePayload("", admitted.files, inboxFileBatchToken("client-message-cleanup"));
  const batchDir = path.dirname(bundle.filePaths[0]!);
  expect(fs.existsSync(bundle.filePaths[0]!)).toBe(true);

  deleteInboxFiles(bundle.filePaths);
  expect(fs.existsSync(bundle.filePaths[0]!)).toBe(false);
  expect(fs.existsSync(batchDir)).toBe(false);
  /* Cleaning an already-clean batch is a no-op, like deleteInboxImages. */
  expect(() => deleteInboxFiles(bundle.filePaths)).not.toThrow();
});

test("two attachments in one send keep both names and both paths", () => {
  const admitted = admitInboxFilePayload({
    files: [upload("first.txt", "one"), upload("second.txt", "two")],
  });
  const bundle = buildFilePayload("both please", admitted.files, inboxFileBatchToken("client-message-pair"));
  expect(bundle.filePaths.map((file) => path.basename(file))).toEqual(["first.txt", "second.txt"]);
  expect(bundle.payload.split("\n")).toEqual(["both please", ...bundle.filePaths]);
  deleteInboxFiles(bundle.filePaths);
});

test("a name collision inside one send keeps both files distinguishable", () => {
  const admitted = admitInboxFilePayload({
    files: [upload("same.txt", "first"), upload("same.txt", "second")],
  });
  const bundle = buildFilePayload("", admitted.files, inboxFileBatchToken("client-message-collision"));
  expect(new Set(bundle.filePaths).size).toBe(2);
  expect(fs.readFileSync(bundle.filePaths[0]!, "utf8")).toBe("first");
  expect(fs.readFileSync(bundle.filePaths[1]!, "utf8")).toBe("second");
  deleteInboxFiles(bundle.filePaths);
});
