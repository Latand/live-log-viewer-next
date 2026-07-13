# Demo media

Every image and video in this directory is generated from the synthetic demo
fixture in `fixtures/demo-home/` — no real agent data, no hand-edited frames.
Two deterministic pipelines produce everything:

## Stills

```bash
bun run demo:capture
```

Renders the six PNGs (`chat-feed.png`, `session-tree.png`, `codex-session.png`,
`overview-board.png`, `pending-question.png`, `review-loop.png`). The runner
(`scripts/demo-capture.ts`):

1. materializes a disposable home under `fixtures/demo-home/.capture/`,
2. boots an isolated Next.js dev server against it (port `3028`, override with
   `DEMO_CAPTURE_PORT`),
3. renders every shot twice inside the pinned `mcp/puppeteer` Docker image and
   publishes it only when both passes agree and the element + pixel gates pass.

Set `DEMO_CAPTURE_DEBUG=1` to dump a `debug-<shot>.png` frame when an element
assertion fails.

## Motion (GIFs + demo.mp4)

```bash
bun run demo:motion
```

Renders the four flow GIFs (`board-to-live-tail.gif`, `spawn-agent.gif`,
`review-loop.gif`, `pending-question.gif`) and stitches `demo.mp4` from every
segment (brand intro/outro cards + the four flows). The runner
(`scripts/demo-motion.ts`, storyboards declared as data in the same file):

1. reuses the stills fixture bootstrap — same disposable home, same pinned
   browser image (server port `3029`, override with `DEMO_MOTION_PORT`),
2. plays each storyboard with a synthetic cursor driven by real CDP input
   events, human pacing and captions, recording frames over CDP screencast,
3. drives the live moments through the real product paths: the hero tail grows
   because transcript records are appended to the fixture while recording, and
   the pending question is answered end-to-end via `POST /api/answer` against
   an interactive fixture tmux pane
   (`scripts/demo-motion-question-pane.cjs`),
4. gates sampled frames with the stage A pixel checks, asserts every
   storyboard checkpoint, then assembles the outputs with host `ffmpeg`
   (GIFs: 12 fps, 960 px wide, infinite loop; mp4: 30 fps, 1280×720, H.264)
   and enforces durations (6–12 s per GIF, 30–60 s for the mp4).

On a checkpoint failure the runner leaves `<storyboard>-fail.png` and the raw
frames under `fixtures/demo-home/.capture/motion/` for inspection.

## Requirements

- Docker (pulls the pinned `mcp/puppeteer` image by digest)
- `ffmpeg`/`ffprobe` on the host (motion only)
- `tmux` and `bun`
- A free TCP port (`3028` stills / `3029` motion)

## Determinism

The fixture home is rebuilt from `fixtures/demo-home/home/` on every run, file
mtimes are pinned to the fixture instant, the page clock is frozen, and the
browser image is pinned by digest — so reruns produce the same frames on any
machine. Contract tests (`scripts/demo-capture.test.ts`,
`scripts/demo-motion.test.ts`) keep shot and storyboard definitions honest
without needing Docker.
