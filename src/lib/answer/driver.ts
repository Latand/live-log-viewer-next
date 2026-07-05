import { screenTail } from "@/lib/status";
import type { PendingQuestion, PendingQuestionItem } from "@/lib/types";

import { composerReady, optionMatches, parseOptions, planOption, screenHasFragment, screenMatchesQuestion } from "./menu";

/**
 * The sequencing half of answering a TUI question: arrow the cursor to an
 * option, press Enter/Space, wait for the screen to advance. All pane access
 * goes through the injected PaneIo port, so the whole flow can be driven
 * against recorded screen fixtures instead of a live tmux pane.
 */

export interface PaneIo {
  paneScreen(target: string): Promise<string>;
  sendKeys(target: string, keys: string[]): Promise<void>;
  sendText(target: string, text: string): Promise<void>;
}

export interface AnswerInput {
  answers?: unknown;
  approve?: unknown;
  text?: unknown;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SCREEN_WAIT_MS = 8_000;
const SCREEN_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyInitialScreen(screen: string, pending: PendingQuestion): void {
  if (screenMatchesQuestion(screen, pending)) return;
  throw new DeliveryError(`екран не схожий на це питання: ${screenTail(screen)}`, 409);
}

function selectedIndexes(question: PendingQuestionItem, raw: unknown): number[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0 && value < question.options.length);
}

function answerLabel(pending: PendingQuestion, body: AnswerInput): string {
  if (pending.kind === "plan") return body.approve === false ? "відхилено" : "затверджено";
  if (typeof body.text === "string" && body.text.trim()) return body.text.trim();
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const labels: string[] = [];
  pending.questions?.forEach((question, qIndex) => {
    for (const index of selectedIndexes(question, answers[qIndex])) labels.push(question.options[index]?.label ?? String(index + 1));
  });
  return labels.join(", ") || "відповідь";
}

async function waitForScreen(io: PaneIo, target: string, predicate: (screen: string) => boolean): Promise<string> {
  const deadline = Date.now() + SCREEN_WAIT_MS;
  while (Date.now() < deadline) {
    const screen = await io.paneScreen(target);
    if (predicate(screen)) return screen;
    await sleep(SCREEN_POLL_MS);
  }
  const screen = await io.paneScreen(target);
  throw new DeliveryError(`екран не змінився як очікувалось: ${screenTail(screen)}`, 502);
}

async function moveToOption(io: PaneIo, target: string, expectedLabel: string): Promise<string> {
  let screen = await io.paneScreen(target);
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
    await io.sendKeys(target, [key]);
    screen = await waitForScreen(io, target, (nextScreen) => {
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

async function answerPlan(io: PaneIo, target: string, pending: PendingQuestion, body: AnswerInput): Promise<string> {
  const approve = body.approve !== false;
  const screen = await io.paneScreen(target);
  verifyInitialScreen(screen, pending);
  const hit = planOption(screen, approve);
  if (!hit) throw new DeliveryError(`не знайдено потрібний варіант плану: ${screenTail(screen)}`, 502);
  await moveToOption(io, target, hit.label);
  await io.sendKeys(target, ["Enter"]);
  if (!approve && typeof body.text === "string" && body.text.trim()) {
    await waitForScreen(io, target, composerReady);
    await io.sendText(target, body.text.trim());
  }
  return approve ? "затверджено" : "відхилено";
}

async function answerQuestions(io: PaneIo, target: string, pending: PendingQuestion, body: AnswerInput): Promise<string> {
  if (typeof body.text === "string" && body.text.trim()) {
    if ((pending.questions?.length ?? 0) > 1) throw new DeliveryError("для кількох питань потрібні відповіді на кожне", 400);
    await io.sendText(target, body.text.trim());
    return body.text.trim();
  }
  const answers = Array.isArray(body.answers) ? body.answers : [];
  const questions = pending.questions ?? [];
  const startScreen = await io.paneScreen(target);
  const startIndex = questions.findIndex((question) => screenHasFragment(startScreen, question.question));
  if (startIndex < 0 && questions.length) throw new DeliveryError(`поточне питання не видно на екрані: ${screenTail(startScreen)}`, 502);
  for (let qIndex = Math.max(0, startIndex); qIndex < questions.length; qIndex += 1) {
    const question = pending.questions![qIndex]!;
    await waitForScreen(io, target, (screen) => screenHasFragment(screen, question.question));
    const chosen = selectedIndexes(question, answers[qIndex]);
    if (!chosen.length) throw new DeliveryError(`немає відповіді на питання ${qIndex + 1}`, 400);
    if (question.multiSelect) {
      for (const index of chosen) {
        const label = question.options[index]!.label;
        await moveToOption(io, target, label);
        await io.sendKeys(target, ["Space"]);
        await moveToOption(io, target, label);
      }
      const last = question.options[chosen.at(-1)!]!.label;
      await moveToOption(io, target, last);
      await io.sendKeys(target, ["Enter"]);
    } else {
      const label = question.options[chosen[0]!]!.label;
      await moveToOption(io, target, label);
      await io.sendKeys(target, ["Enter"]);
    }
    const next = pending.questions?.[qIndex + 1];
    if (next) await waitForScreen(io, target, (screen) => screenHasFragment(screen, next.question));
  }
  return answerLabel(pending, body);
}

/**
 * Verifies the pane still shows the pending question, then walks the dialog
 * to deliver the chosen answer. Returns the human-readable answer label.
 */
export async function deliverAnswer(io: PaneIo, target: string, pending: PendingQuestion, body: AnswerInput): Promise<string> {
  verifyInitialScreen(await io.paneScreen(target), pending);
  return pending.kind === "plan" ? answerPlan(io, target, pending, body) : answerQuestions(io, target, pending, body);
}
