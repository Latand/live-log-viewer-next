import { describe, expect, test } from "bun:test";

import { PENDING_QUESTION_FILE, renderFixtureTemplate } from "./demo-capture";
import {
  GIF_DURATION_BOUNDS,
  MOTION_PIXELS,
  MOTION_VIEWPORT,
  QUESTION_ANSWER_LINES,
  QUESTION_PANE_CONFIG,
  STORYBOARDS,
  VIDEO_DURATION_BOUNDS,
  type MotionStep,
  type Storyboard,
} from "./demo-motion";

function stepsOf(board: Storyboard): MotionStep[] {
  return [...board.setup, ...board.steps];
}

/** Rough lower bound of a storyboard's recorded duration, in milliseconds. */
function plannedRecordingMs(board: Storyboard): number {
  let total = 850; // recorder settle + tail hold
  for (const step of board.steps) {
    if (step.do === "pause" || step.do === "card") total += step.ms;
    else if (step.do === "move") total += step.ms ?? 650;
    else if (step.do === "hover") total += (step.ms ?? 650) + (step.holdMs ?? 400);
    else if (step.do === "click") total += (step.ms ?? 650) + 390;
    else if (step.do === "type") total += step.text.length * 30;
  }
  return total;
}

describe("demo motion contract", () => {
  test("publishes the four flow GIFs and stitches every segment into the video", () => {
    const gifs = STORYBOARDS.map((board) => board.gif).filter((gif): gif is string => gif !== null);
    expect(gifs).toEqual([
      "board-to-live-tail.gif",
      "pending-question.gif",
      "spawn-agent.gif",
      "review-loop.gif",
    ]);
    expect(new Set(STORYBOARDS.map((board) => board.id)).size).toBe(STORYBOARDS.length);
    expect(STORYBOARDS.every((board) => board.video)).toBeTrue();
  });

  test("keeps every GIF inside the 6–12s window by design", () => {
    for (const board of STORYBOARDS) {
      if (!board.gif) continue;
      const planned = plannedRecordingMs(board);
      expect(planned).toBeGreaterThanOrEqual(GIF_DURATION_BOUNDS.min * 1000);
      expect(planned).toBeLessThanOrEqual(GIF_DURATION_BOUNDS.max * 1000);
    }
  });

  test("keeps the stitched video inside the 30–60s window by design", () => {
    const planned = STORYBOARDS.filter((board) => board.video)
      .reduce((total, board) => total + plannedRecordingMs(board), 0);
    expect(planned).toBeGreaterThanOrEqual(VIDEO_DURATION_BOUNDS.min * 1000);
    expect(planned).toBeLessThanOrEqual(VIDEO_DURATION_BOUNDS.max * 1000);
  });

  test("every recorded flow asserts checkpoints and pixel gates", () => {
    for (const board of STORYBOARDS) {
      if (!board.gif) continue;
      const checkpoints = stepsOf(board).filter((step) => step.do === "waitText" || step.do === "waitFor");
      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
      expect(board.pixels).toEqual(MOTION_PIXELS);
    }
  });

  test("storyboard fixture references render against a demo home", () => {
    const home = "/tmp/demo-home/home";
    const rendered = JSON.parse(renderFixtureTemplate(JSON.stringify(STORYBOARDS), home)) as Storyboard[];
    for (const board of rendered) {
      for (const step of stepsOf(board)) {
        if (step.do === "host") expect(step.action.file).toStartWith(home);
      }
    }
    expect(renderFixtureTemplate(PENDING_QUESTION_FILE, home)).toStartWith(home);
  });

  test("host appends carry parseable records stamped inside fixture time", () => {
    for (const board of STORYBOARDS) {
      for (const step of stepsOf(board)) {
        if (step.do !== "host") continue;
        expect(step.action.kind).toBe("append");
        expect(Number.isNaN(Date.parse(step.action.utimeIso))).toBeFalse();
        for (const line of step.action.lines) {
          const record = JSON.parse(line) as { timestamp: string };
          expect(record.timestamp).toStartWith("2100-01-02T");
        }
      }
    }
  });

  test("the pane answer confirms the pending question transcript contract", () => {
    expect(QUESTION_PANE_CONFIG.options[QUESTION_PANE_CONFIG.selected]).toContain("Compact feed");
    const [result, followUp] = QUESTION_ANSWER_LINES.map((line) => JSON.parse(line) as {
      type: string;
      message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> };
    });
    expect(result!.type).toBe("user");
    expect(result!.message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tool-question-framing" });
    expect(followUp!.type).toBe("assistant");
  });

  test("recording geometry stays at the published 720p frame", () => {
    expect(MOTION_VIEWPORT).toEqual({ width: 1280, height: 720 });
  });
});
