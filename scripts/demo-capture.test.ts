import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  DEMO_FIXED_ISO,
  DEMO_TOKEN,
  PUPPETEER_IMAGE,
  SHOTS,
  assertStableText,
  buildDockerClientEnvironment,
  buildDemoEnvironment,
  renderFixtureTemplate,
} from "./demo-capture";

const { assertPixelMetrics, measurePixelMetrics } = require("./demo-capture-browser.cjs") as {
  assertPixelMetrics: (
    metrics: {
      nearBlackRatio: number;
      nonWhiteRatio: number;
      colorCount: number;
      maxTileNearBlackRatio: number;
      maxTile: { column: number; row: number };
    },
    limits: { maxNearBlackRatio: number; minNonWhiteRatio: number; minColorCount: number; maxTileNearBlackRatio: number },
    shotId: string,
  ) => void;
  measurePixelMetrics: (data: Buffer, width: number, height: number, tileSize: number) => {
    nearBlackRatio: number;
    nonWhiteRatio: number;
    colorCount: number;
    maxTileNearBlackRatio: number;
    maxTile: { column: number; row: number };
  };
};

describe("demo capture contract", () => {
  test("publishes one deterministic still for every stage A feature", () => {
    expect(SHOTS.map((shot) => shot.output)).toEqual([
      "chat-feed.png",
      "session-tree.png",
      "codex-session.png",
      "overview-board.png",
      "pending-question.png",
      "review-loop.png",
    ]);
    expect(SHOTS.every((shot) => shot.stableText.length > 0)).toBeTrue();
    expect(SHOTS.every((shot) => shot.frame.visible.length > 0)).toBeTrue();
    expect(SHOTS.every((shot) => shot.frame.pixels.maxNearBlackRatio > 0)).toBeTrue();
    expect(SHOTS.every((shot) => shot.frame.pixels.maxTileNearBlackRatio > 0)).toBeTrue();
    expect(SHOTS.every((shot) => shot.frame.pixels.tileSize > 0)).toBeTrue();
    expect(SHOTS.every((shot) => shot.frame.pixels.minColorCount > 0)).toBeTrue();
    expect(new Set(SHOTS.map((shot) => shot.output)).size).toBe(SHOTS.length);
  });

  test("keeps every mutable capture path inside the generated fixture home", () => {
    const repoRoot = "/workspace/agent-log-viewer";
    const env = buildDemoEnvironment(repoRoot, 1200, { PATH: "/usr/bin" });
    const runtimeRoot = path.join(repoRoot, "fixtures/demo-home/.capture");

    for (const name of ["HOME", "TMPDIR", "TMUX_TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "LLV_STATE_DIR"] as const) {
      expect(path.resolve(env[name]!)).toStartWith(path.resolve(runtimeRoot) + path.sep);
    }
    expect(env.LLV_CLAUDE_HOME).toBe(path.join(env.HOME!, ".claude"));
    expect(env.LLV_CODEX_HOME).toBe(path.join(env.HOME!, ".codex"));
    expect(env.LLV_DEV_ORIGINS).toBe("172.17.0.1");
    expect(env.LLV_ACCOUNT_CONTROLLER_DISABLED).toBe("1");
    expect(env.LLV_RESOURCES_FIXTURE).toBe(path.join(env.LLV_STATE_DIR!, "resources.json"));
    expect(env.LLV_TS_HOST).toBe("172.17.0.1");
    expect(env.TZ).toBe("UTC");
    expect(env.LANG).toBe("C.UTF-8");
  });

  test("pins the browser image and isolates the Docker client environment", () => {
    expect(PUPPETEER_IMAGE).toMatch(/^mcp\/puppeteer@sha256:[0-9a-f]{64}$/);
    expect(buildDockerClientEnvironment({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1200/docker.sock",
      HOME: "/real/home",
      TMPDIR: "/real/tmp",
      TMUX_TMPDIR: "/real/tmux",
      HOST_SECRET: "private",
    })).toEqual({
      NODE_ENV: "production",
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1200/docker.sock",
    });
  });

  test("expands runtime paths without leaving fixture tokens behind", () => {
    const rendered = renderFixtureTemplate(`{"path":"${DEMO_TOKEN}/.codex","at":"${DEMO_FIXED_ISO}"}`, "/fixture/home");
    expect(rendered).toBe(`{"path":"/fixture/home/.codex","at":"${DEMO_FIXED_ISO}"}`);
    expect(() => renderFixtureTemplate(`${DEMO_TOKEN}/a __UNKNOWN_DEMO_TOKEN__`, "/fixture/home")).toThrow("unresolved fixture token");
  });

  test("stable-text assertion reports UI drift", () => {
    expect(() => assertStableText("alpha\n beta", "alpha beta", "chat-feed")).not.toThrow();
    expect(() => assertStableText("alpha", "beta", "chat-feed")).toThrow("chat-feed changed between deterministic passes");
  });

  test("pixel assertions reject compositor corruption and empty frames", () => {
    const limits = { maxNearBlackRatio: 0.05, minNonWhiteRatio: 0.15, minColorCount: 100, maxTileNearBlackRatio: 0.2 };
    const maxTile = { column: 0, row: 0 };
    expect(() => assertPixelMetrics({ nearBlackRatio: 0.01, nonWhiteRatio: 0.4, colorCount: 180, maxTileNearBlackRatio: 0.01, maxTile }, limits, "review-loop")).not.toThrow();
    expect(() => assertPixelMetrics({ nearBlackRatio: 0.4, nonWhiteRatio: 0.5, colorCount: 180, maxTileNearBlackRatio: 0.8, maxTile }, limits, "review-loop")).toThrow("near-black pixels");
    expect(() => assertPixelMetrics({ nearBlackRatio: 0.01, nonWhiteRatio: 0.01, colorCount: 180, maxTileNearBlackRatio: 0.01, maxTile }, limits, "overview-board")).toThrow("non-white pixels");
    expect(() => assertPixelMetrics({ nearBlackRatio: 0.01, nonWhiteRatio: 0.4, colorCount: 4, maxTileNearBlackRatio: 0.01, maxTile }, limits, "chat-feed")).toThrow("quantized colors");
  });

  test("spatial pixel assertions reject a localized 180x100 black block", () => {
    const width = 920;
    const height = 420;
    const pixels = Buffer.alloc(width * height * 3, 255);
    for (let y = 140; y < 240; y += 1) {
      pixels.fill(0, (y * width + 360) * 3, (y * width + 540) * 3);
    }
    const measured = measurePixelMetrics(pixels, width, height, 64);
    expect(measured.nearBlackRatio).toBeCloseTo(18_000 / (width * height), 6);
    expect(measured.nearBlackRatio).toBeLessThan(0.05);
    expect(measured.maxTileNearBlackRatio).toBeGreaterThan(0.2);
    expect(() => assertPixelMetrics(
      { ...measured, nonWhiteRatio: 0.4, colorCount: 180 },
      { maxNearBlackRatio: 0.05, minNonWhiteRatio: 0.15, minColorCount: 100, maxTileNearBlackRatio: 0.2 },
      "overview-board",
    )).toThrow("near-black tile");
  });
});
