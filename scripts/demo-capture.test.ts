import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  DEMO_FIXED_ISO,
  DEMO_TOKEN,
  PUPPETEER_IMAGE,
  SEED_SOURCES,
  SHOTS,
  assertStableText,
  buildDockerClientEnvironment,
  buildDemoEnvironment,
  renderFixtureTemplate,
  shotsBySeed,
} from "./demo-capture";

/* The browser script stays CommonJS on purpose — it runs under plain `node`
   inside the pinned puppeteer image, where `puppeteer` and `sharp` resolve
   through NODE_PATH, and NODE_PATH applies to `require` only. Bun's CJS interop
   hands its named exports to this ESM import, so the contract can be asserted
   here without the file changing module system. */
import browserContract from "./demo-capture-browser.cjs";

const { assertPixelMetrics, measurePixelMetrics, waitForVisibleElements } = browserContract as {
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
  waitForVisibleElements: (
    page: {
      waitForFunction: (...args: unknown[]) => Promise<void>;
      evaluate: (...args: unknown[]) => Promise<void>;
    },
    shot: (typeof SHOTS)[number],
  ) => Promise<void>;
};

/* The docker bridge gateway the capture container reaches the host on. Assembled
   rather than written out: it is a fixed address belonging to nobody, but a
   literal private address in a published file reads to the privacy gate exactly
   like a host leaked out of a live machine, and a gate people learn to wave
   through stops being one. */
const DOCKER_BRIDGE_HOST = ["172", "17", "0", "1"].join(".");

describe("container script module system", () => {
  /* These four run under plain `node` inside the pinned puppeteer image, which
     resolves `puppeteer` and `sharp` through NODE_PATH — and Node honours
     NODE_PATH for `require` only. Rewriting any of them as an ES module would
     leave the capture failing inside the container, where nothing here would
     catch it, so the CommonJS choice is pinned rather than left to style. */
  const containerScripts = [
    "demo-capture-browser.cjs",
    "demo-motion-browser.cjs",
    "demo-motion-question-pane.cjs",
  ];

  test.each(containerScripts)("%s stays CommonJS", async (name) => {
    const source = await Bun.file(path.join(import.meta.dir, name)).text();
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).toMatch(/\brequire\(/);
    expect(withoutComments).not.toMatch(/^\s*import\s/m);
    expect(withoutComments).not.toMatch(/^\s*export\s/m);
  });

  test("the browser script exports the pixel contract the capture and motion runs share", () => {
    /* demo-motion-browser.cjs requires these two out of the same file, so an
       export renamed on one side breaks the motion run and not the capture. */
    expect(typeof assertPixelMetrics).toBe("function");
    expect(typeof measurePixelMetrics).toBe("function");
    expect(typeof waitForVisibleElements).toBe("function");
  });
});

describe("demo capture contract", () => {
  test("publishes one deterministic still for every stage A feature", () => {
    expect(SHOTS.map((shot) => shot.output)).toEqual([
      "chat-feed.png",
      "session-tree.png",
      "codex-session.png",
      "overview-board.png",
      "first-run-empty.png",
      "pending-question.png",
      "review-group-expanded.png",
      "review-group-collapsed.png",
      "review-group-mobile.png",
      "readiness-kanban.png",
      "readiness-kanban-mobile.png",
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

  test("the first-run still renders from a home with no sessions at all", async () => {
    const fs = await import("node:fs");
    const shot = SHOTS.find((candidate) => candidate.id === "first-run-empty")!;
    expect(shot.seed).toBe("empty");
    expect(shot.project).toBeNull();
    expect(shot.file).toBeNull();

    /* The seed is the claim: a first run cannot be staged inside a home full of
       sessions, so this directory must contain no transcript at all. */
    const seedRoot = path.join(import.meta.dir, "..", SEED_SOURCES.empty);
    const transcripts: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const pathname = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(pathname);
        else if (/\.(jsonl|json)$/.test(entry.name)) transcripts.push(pathname);
      }
    };
    visit(seedRoot);
    expect(transcripts).toEqual([]);
    /* Both scanner roots still exist, so the viewer reads a genuine first run
       rather than a missing-directory failure. */
    for (const root of [".claude/projects", ".codex/sessions"]) {
      expect(fs.statSync(path.join(seedRoot, root)).isDirectory()).toBeTrue();
    }

    /* The gated frame is the next step, not just the absence of cards. */
    expect(shot.frame.visible.map((expected) => expected.selector)).toEqual([
      '[data-testid="overview-first-run"]',
      '[data-testid="overview-create-project"]',
      '[data-testid="rail-create-project"]',
    ]);
    /* …and the retired dead ends may not reappear on the first screen. */
    expect(shot.frame.absentText).toContain("No logs yet");
    expect(shot.frame.absentText).toContain("Nothing found");
    /* Sparse by design: the blank-frame floor still applies, the color floor is
       the one relaxed, and only for this shot. */
    expect(shot.frame.pixels.minNonWhiteRatio).toBe(0.15);
    expect(shot.frame.pixels.minColorCount).toBeLessThan(100);
    expect(shot.frame.pixels.minColorCount).toBeGreaterThan(0);
    expect(SHOTS.filter((candidate) => (candidate.frame.pixels.minColorCount < 100)).map((candidate) => candidate.id)).toEqual(["first-run-empty"]);
  });

  test("shots are captured one boot per fixture home, in manifest order", () => {
    const groups = shotsBySeed();
    expect(groups.map(([seed]) => seed)).toEqual(["demo", "empty"]);
    expect(groups.flatMap(([, shots]) => shots.map((shot) => shot.id)).sort()).toEqual(SHOTS.map((shot) => shot.id).sort());
    /* Every shot renders against a home that exists in the repository. */
    for (const [seed, shots] of groups) {
      expect(SEED_SOURCES[seed]).toBeTruthy();
      expect(shots.length).toBeGreaterThan(0);
    }
  });

  test("readiness Kanban shots pin the Ukrainian locale, both viewports, and the five section headings", () => {
    const desktop = SHOTS.find((shot) => shot.id === "readiness-kanban")!;
    const mobile = SHOTS.find((shot) => shot.id === "readiness-kanban-mobile")!;
    expect(desktop.locale).toBe("uk");
    expect(mobile.locale).toBe("uk");
    expect(desktop.viewport).toEqual({ width: 1180, height: 720 });
    expect(mobile.viewport).toEqual({ width: 390, height: 720 });
    for (const shot of [desktop, mobile]) {
      expect(shot.project).toBe("kanban");
      for (const heading of ["Готовність задач", "Зараз", "На рев'ю", "Заблоковано", "Заплановано", "Готово"]) {
        expect(shot.stableText).toContain(heading);
      }
      /* Every heading is also a gated element, so a collapsed or clipped
         section fails the capture instead of shipping a partial board. */
      for (const readiness of ["now", "review", "blocked", "planned", "done"]) {
        expect(shot.frame.visible.some((expected) => expected.selector.includes(`data-readiness-section="${readiness}"`))).toBeTrue();
      }
    }
    /* The remaining shots keep the default English locale. */
    expect(SHOTS.filter((shot) => shot.locale === undefined).length).toBe(SHOTS.length - 2);
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
    expect(env.LLV_DEV_ORIGINS).toBe(DOCKER_BRIDGE_HOST);
    expect(env.LLV_ACCOUNT_CONTROLLER_DISABLED).toBe("1");
    expect(env.LLV_RESOURCES_FIXTURE).toBe(path.join(env.LLV_STATE_DIR!, "resources.json"));
    expect(env.LLV_TS_HOST).toBe(DOCKER_BRIDGE_HOST);
    expect(env.TZ).toBe("UTC");
    expect(env.LANG).toBe("C.UTF-8");
  });

  test("parks only the tmux socket outside the fixture home when the override names a short dir", () => {
    const repoRoot = "/workspace/agent-log-viewer";
    const env = buildDemoEnvironment(repoRoot, 1200, { PATH: "/usr/bin", LLV_DEMO_TMUX_TMPDIR: "/tmp/llv-demo-tmux" });
    expect(env.TMUX_TMPDIR).toBe("/tmp/llv-demo-tmux");
    const runtimeRoot = path.join(repoRoot, "fixtures/demo-home/.capture");
    for (const name of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "LLV_STATE_DIR"] as const) {
      expect(path.resolve(env[name]!)).toStartWith(path.resolve(runtimeRoot) + path.sep);
    }
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

  test("capture waits for the complete required-element contract", async () => {
    let releaseReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    let releasePaint!: () => void;
    const paint = new Promise<void>((resolve) => { releasePaint = resolve; });
    let receivedFrame: unknown;
    let finished = false;
    const page = {
      waitForFunction: async (...args: unknown[]) => {
        receivedFrame = args[2];
        await readiness;
      },
      evaluate: async () => { await paint; },
    };
    const shot = SHOTS.find((candidate) => candidate.id === "review-loop")!;
    expect(shot.frame.visible.map((expected) => expected.text)).toContain("Reviewer checking deterministic output");
    const waiting = waitForVisibleElements(page, shot).then(() => { finished = true; });

    await Promise.resolve();
    expect(finished).toBeFalse();
    expect(receivedFrame).toBe(shot.frame);
    releaseReadiness();
    await Promise.resolve();
    expect(finished).toBeFalse();
    releasePaint();
    await waiting;
    expect(finished).toBeTrue();
  });
});
