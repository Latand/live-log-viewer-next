export const METER_BARS = 13;
export const METER_WIDTH = 56;
export const METER_HEIGHT = 16;
/* Voice energy lives in the lower spectrum; the top bins of a 64-bin FFT stay
   near zero and would render as permanently dead bars. */
const METER_SPECTRUM_SHARE = 0.65;

export function fmtElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The danger role resolved to RGB from the active theme's `--color-danger`
    token. The canvas 2D `fillStyle` cannot read a CSS variable, so we resolve it
    per frame — this way the meter adopts the dark danger color in dark mode
    instead of the baked-in light literal. Falls back to the light danger hex
    when there is no DOM (SSR/tests). */
function dangerRgb(): [number, number, number] {
  const fallback: [number, number, number] = [198, 40, 40];
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--color-danger").trim();
  const hex = raw.startsWith("#") ? raw.slice(1) : "";
  if (hex.length !== 6) return fallback;
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function drawMeter(canvas: HTMLCanvasElement, bins: Uint8Array): void {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== METER_WIDTH * dpr || canvas.height !== METER_HEIGHT * dpr) {
    canvas.width = METER_WIDTH * dpr;
    canvas.height = METER_HEIGHT * dpr;
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, METER_WIDTH, METER_HEIGHT);
  const usable = Math.max(METER_BARS, Math.floor(bins.length * METER_SPECTRUM_SHARE));
  const step = usable / METER_BARS;
  const barWidth = METER_WIDTH / METER_BARS;
  const [dr, dg, db] = dangerRgb();
  for (let i = 0; i < METER_BARS; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += bins[j] ?? 0;
    const level = sum / (to - from) / 255;
    const barHeight = Math.max(1.5, level * METER_HEIGHT);
    g.fillStyle = `rgba(${dr}, ${dg}, ${db}, ${(0.35 + level * 0.65).toFixed(3)})`;
    g.fillRect(i * barWidth + 1, (METER_HEIGHT - barHeight) / 2, barWidth - 2, barHeight);
  }
}

export function float32ToBase64Pcm16(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i] ?? 0));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}
