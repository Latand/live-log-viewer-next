import fs from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { pendingQuestionFor, recordedToolResult } from "@/lib/scanner/questions";
import { paneScreen, READY_MARKERS, resolveTarget, screenTail, sendKeys, sendText } from "@/lib/tmux";
import type { ApiError, FileEntry, PendingQuestion, PendingQuestionItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIRM_MS = 10_000;
const CONFIRM_POLL_MS = 500;
const SCREEN_WAIT_MS = 8_000;
const SCREEN_POLL_MS = 250;

interface AnswerBody {
  transcriptPath?: unknown;
  toolUseId?: unknown;
  kind?: unknown;
  answers?: unknown;
  approve?: unknown;
  text?: unknown;
}

interface AnswerResponse {
  ok: true;
  answer: string;
}

interface SupersededResponse {
  error: string;
  answer: string;
  superseded: true;
}

type RouteResponse = AnswerResponse | SupersededResponse | ApiError;

const locks = new Map<string, Promise<NextResponse<RouteResponse>>>();

interface OptionLine {
  index: number;
  raw: string;
  label: string;
  normalized: string;
  highlighted: boolean;
}

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/[│┃║╎╏─━═┌┐└┘╭╮╰╯├┤┬┴┼╠╣╦╩╬]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fragments(text: string): string[] {
  const words = normalizeText(text).split(" ").filter((word) => word.length >= 3);
  const out: string[] = [];
  for (let size = Math.min(5, words.length); size >= 2; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const fragment = words.slice(i, i + size).join(" ");
      if (fragment.length >= 12 && fragment.length <= 55) out.push(fragment);
    }
  }
  return out;
}

function screenHasFragment(screen: string, text: string): boolean {
  const normalized = normalizeText(screen);
  const candidates = fragments(text);
  if (candidates.length) return candidates.some((fragment) => normalized.includes(fragment));
  const fallback = normalizeText(text);
  return fallback.length > 0 && normalized.includes(fallback);
}

function verifyInitialScreen(screen: string, pending: PendingQuestion): void {
  const sources = pending.kind === "plan" ? [pending.plan ?? ""] : pending.questions?.map((question) => question.question) ?? [];
  if (sources.some((source) => source && screenHasFragment(screen, source))) return;
  throw new DeliveryError(`екран не схожий на це питання: ${screenTail(screen)}`, 409);
}

function cleanOptionLabel(line: string): string {
  return line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/^[\s│┃║╎╏>❯›▶▸➜→*-]+/, "")
    .replace(/^[○●◉◯☐☑✓✔]\s*/, "")
    .replace(/^\d+[\).:]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isOptionLine(line: string): boolean {
  return /^\s*(?:[│┃║╎╏]\s*)?(?:[>❯›▶▸➜→]\s*)?(?:[○●◉◯☐☑✓✔]\s*)?(?:\d+[\).:]|[-*])\s+/.test(line);
}

function isHighlighted(line: string): boolean {
  return /^\s*(?:[│┃║╎╏]\s*)?[>❯›▶▸➜→]/.test(line);
}

function parseAllOptions(screen: string): OptionLine[] {
  const lines = screen.split("\n");
  const options: OptionLine[] = [];
  for (const [index, raw] of lines.entries()) {
    if (!isOptionLine(raw)) continue;
    const label = cleanOptionLabel(raw);
    if (!label) continue;
    options.push({ index, raw, label, normalized: normalizeText(label), highlighted: isHighlighted(raw) });
  }
  return options;
}

function parseOptions(screen: string): OptionLine[] {
  const options = parseAllOptions(screen);
  const active = options.findLast((option) => option.highlighted);
  if (!active) return options;
  const members = new Set<number>([active.index]);
  let cursor = active.index - 1;
  while (options.some((option) => option.index === cursor)) {
    members.add(cursor);
    cursor -= 1;
  }
  cursor = active.index + 1;
  while (options.some((option) => option.index === cursor)) {
    members.add(cursor);
    cursor += 1;
  }
  return options.filter((option) => members.has(option.index));
}

function optionMatches(option: OptionLine, expected: string): boolean {
  const label = normalizeText(expected);
  return option.normalized.includes(label) || label.includes(option.normalized);
}

function selectedIndexes(question: PendingQuestionItem, raw: unknown): number[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0 && value < question.options.length);
}

function answerLabel(pending: PendingQuestion, body: AnswerBody): string {
  if (pending.kind === "plan") return body.approve === false ? "відхилено" : "затверджено";
  if (typeof body.text === "string" && body.text.trim()) return body.text.trim();
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const labels: string[] = [];
  pending.questions?.forEach((question, qIndex) => {
    for (const index of selectedIndexes(question, answers[qIndex])) labels.push(question.options[index]?.label ?? String(index + 1));
  });
  return labels.join(", ") || "відповідь";
}

async function moveToOption(target: string, expectedLabel: string): Promise<string> {
  let screen = await paneScreen(target);
  let options = parseOptions(screen);
  let targetIndex = options.findIndex((option) => optionMatches(option, expectedLabel));
  let currentIndex = options.findIndex((option) => option.highlighted);
  if (targetIndex < 0) throw new DeliveryError(`варіант не видно на екрані: ${expectedLabel}; ${screenTail(screen)}`, 502);
  if (currentIndex < 0) throw new DeliveryError(`не видно активного варіанта: ${screenTail(screen)}`, 502);
  let guard = 0;
  while (currentIndex !== targetIndex) {
    guard += 1;
    if (guard > options.length + 2) throw new DeliveryError(`не вдалося дійти до «${expectedLabel}»: ${screenTail(screen)}`, 502);
    const key = targetIndex > currentIndex ? "Down" : "Up";
    const previousLine = options[currentIndex]?.index;
    await sendKeys(target, [key]);
    screen = await waitForScreen(target, (nextScreen) => {
      const nextActive = parseOptions(nextScreen).find((option) => option.highlighted);
      return nextActive !== undefined && nextActive.index !== previousLine;
    });
    options = parseOptions(screen);
    targetIndex = options.findIndex((option) => optionMatches(option, expectedLabel));
    currentIndex = options.findIndex((option) => option.highlighted);
    if (targetIndex < 0 || currentIndex < 0) throw new DeliveryError(`після навігації варіант зник: ${screenTail(screen)}`, 502);
  }
  const active = options[currentIndex];
  if (!active || !optionMatches(active, expectedLabel)) {
    throw new DeliveryError(`активний варіант не збігається з «${expectedLabel}»: ${screenTail(screen)}`, 502);
  }
  return screen;
}

async function waitForScreen(target: string, predicate: (screen: string) => boolean): Promise<string> {
  const deadline = Date.now() + SCREEN_WAIT_MS;
  while (Date.now() < deadline) {
    const screen = await paneScreen(target);
    if (predicate(screen)) return screen;
    await sleep(SCREEN_POLL_MS);
  }
  const screen = await paneScreen(target);
  throw new DeliveryError(`екран не змінився як очікувалось: ${screenTail(screen)}`, 502);
}

function composerReady(screen: string): boolean {
  const tail = screen.split("\n").slice(-8).join("\n");
  return READY_MARKERS.test(tail) || /^\s*[❯›]/m.test(tail);
}

function planOptionLabel(screen: string, approve: boolean): string {
  const options = parseOptions(screen);
  const plainAccept = /\b(yes|approve|accept|proceed)\b|затверд|схвал/i;
  const autoAccept = /\bauto[- ]?accept\b/i;
  const reject = /\b(no|reject|keep planning|continue planning)\b|відхил|назад/i;
  const hit = approve
    ? options.find((option) => plainAccept.test(option.label) && !autoAccept.test(option.label)) ?? options.find((option) => plainAccept.test(option.label))
    : options.find((option) => reject.test(option.label));
  if (!hit) throw new DeliveryError(`не знайдено потрібний варіант плану: ${screenTail(screen)}`, 502);
  return hit.label;
}

async function answerPlan(target: string, pending: PendingQuestion, body: AnswerBody): Promise<string> {
  const approve = body.approve !== false;
  const screen = await paneScreen(target);
  verifyInitialScreen(screen, pending);
  const label = planOptionLabel(screen, approve);
  await moveToOption(target, label);
  await sendKeys(target, ["Enter"]);
  if (!approve && typeof body.text === "string" && body.text.trim()) {
    await waitForScreen(target, composerReady);
    await sendText(target, body.text.trim());
  }
  return approve ? "затверджено" : "відхилено";
}

async function answerQuestions(target: string, pending: PendingQuestion, body: AnswerBody): Promise<string> {
  if (typeof body.text === "string" && body.text.trim()) {
    if ((pending.questions?.length ?? 0) > 1) throw new DeliveryError("для кількох питань потрібні відповіді на кожне", 400);
    await sendText(target, body.text.trim());
    return body.text.trim();
  }
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const questions = pending.questions ?? [];
  const startScreen = await paneScreen(target);
  const startIndex = questions.findIndex((question) => screenHasFragment(startScreen, question.question));
  if (startIndex < 0 && questions.length) throw new DeliveryError(`поточне питання не видно на екрані: ${screenTail(startScreen)}`, 502);
  for (let qIndex = Math.max(0, startIndex); qIndex < questions.length; qIndex += 1) {
    const question = pending.questions![qIndex]!;
    await waitForScreen(target, (screen) => screenHasFragment(screen, question.question));
    const chosen = selectedIndexes(question, answers[qIndex]);
    if (!chosen.length) throw new DeliveryError(`немає відповіді на питання ${qIndex + 1}`, 400);
    if (question.multiSelect) {
      for (const index of chosen) {
        const label = question.options[index]!.label;
        await moveToOption(target, label);
        await sendKeys(target, ["Space"]);
        await moveToOption(target, label);
      }
      const last = question.options[chosen.at(-1)!]!.label;
      await moveToOption(target, last);
      await sendKeys(target, ["Enter"]);
    } else {
      const label = question.options[chosen[0]!]!.label;
      await moveToOption(target, label);
      await sendKeys(target, ["Enter"]);
    }
    const next = pending.questions?.[qIndex + 1];
    if (next) await waitForScreen(target, (screen) => screenHasFragment(screen, next.question));
  }
  return answerLabel(pending, body);
}

function freshEntry(entry: FileEntry): FileEntry | null {
  try {
    const st = fs.statSync(entry.path);
    return { ...entry, size: st.size, mtime: st.mtimeMs / 1000 };
  } catch {
    return null;
  }
}

function transcriptResult(entry: FileEntry, toolUseId: string): string | null {
  const fresh = freshEntry(entry);
  if (!fresh) return null;
  return recordedToolResult(fresh.path, fresh.size, toolUseId);
}

async function knownState(pathname: string, toolUseId: string): Promise<{ entry: FileEntry; pending: PendingQuestion | null; result: string | null } | null> {
  const entry = (await listFiles()).find((item) => item.path === pathname);
  if (!entry || entry.proc !== "running" || entry.pid === null) return null;
  const fresh = freshEntry(entry);
  if (!fresh) return null;
  const result = recordedToolResult(fresh.path, fresh.size, toolUseId);
  if (result) return { entry: fresh, pending: null, result };
  const pending = pendingQuestionFor(fresh);
  return { entry: fresh, pending: pending?.toolUseId === toolUseId ? pending : null, result: null };
}

async function confirmAnswered(entry: FileEntry, toolUseId: string): Promise<string | null> {
  const deadline = Date.now() + CONFIRM_MS;
  while (Date.now() < deadline) {
    const result = transcriptResult(entry, toolUseId);
    if (result) return result;
    await sleep(CONFIRM_POLL_MS);
  }
  return null;
}

async function deliver(body: AnswerBody): Promise<NextResponse<RouteResponse>> {
  const transcriptPath = typeof body.transcriptPath === "string" ? body.transcriptPath : "";
  const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId : "";
  if (!transcriptPath || !toolUseId) return NextResponse.json({ error: "потрібен transcriptPath і toolUseId" }, { status: 400 });

  const state = await knownState(transcriptPath, toolUseId);
  if (!state) return NextResponse.json({ error: "транскрипт невідомий або агент не працює" }, { status: 403 });
  if (state.result) {
    return NextResponse.json(
      { error: "питання вже має відповідь", answer: state.result, superseded: true },
      { status: 409 },
    );
  }
  if (state.pending === null) return NextResponse.json({ error: "питання вже не активне" }, { status: 409 });
  const pending = state.pending;
  const target = await resolveTarget(state.entry.pid!);
  if (target === null) return NextResponse.json({ error: "немає активного tmux-пейна для відповіді", noPane: true }, { status: 409 });

  try {
    verifyInitialScreen(await paneScreen(target), pending);
    const label = pending.kind === "plan" ? await answerPlan(target, pending, body) : await answerQuestions(target, pending, body);
    const recorded = await confirmAnswered(state.entry, toolUseId);
    if (recorded) return NextResponse.json({ ok: true, answer: recorded || label });
    return NextResponse.json({ error: `відповідь надіслано, але транскрипт не підтвердив її: ${screenTail(await paneScreen(target))}` }, { status: 502 });
  } catch (error) {
    if (error instanceof DeliveryError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse<RouteResponse>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: AnswerBody;
  try {
    body = (await req.json()) as AnswerBody;
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
  const transcriptPath = typeof body.transcriptPath === "string" ? body.transcriptPath : "";
  const key = transcriptPath || "unknown";
  const previous = locks.get(key) ?? Promise.resolve(NextResponse.json({ ok: true, answer: "" }));
  const current = previous.catch(() => NextResponse.json({ ok: true, answer: "" })).then(() => deliver(body));
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
