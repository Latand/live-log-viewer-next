/**
 * Deterministic, fully SYNTHETIC acceptance evidence for PR #441
 * (subagent badge anchors).
 *
 *   bun docs/acceptance/pr-441/capture.ts
 *
 * The reviewed blockers are frontend interaction/geometry changes. This runner
 * has no browser or Docker available in the pipeline sandbox, so instead of
 * scraping a LIVE board (which the two `chore(privacy): remove live board
 * evidence` commits deliberately stripped) it renders the badge surface from the
 * SAME pure geometry the product ships — `subagentsOf` (current-generation
 * selection + bottom-up order) and `layoutBadges` (30x30 placement, right-edge
 * anchoring, hard-cap overflow) — over hand-authored fictional data, and emits
 * the auditable `.svg` geometry stills.
 *
 * The published `.png` companions are NOT rendered here: they are deterministic
 * redacted placeholders emitted by the approved trusted generator
 * `scripts/generate-privacy-placeholders.ts`, carrying schema-v2 provenance in
 * `privacy-manifest.json`. This keeps the raster evidence reproducible from the
 * trusted publication gate rather than from an ad-hoc `sharp` rasterization.
 *
 * PRIVACY: every id, title, path, project and model below is invented for these
 * stills. No real project name, account, filesystem path, transcript text, or
 * user data is read or embedded. The output SVGs are therefore safe to publish.
 */
import fs from "node:fs";
import path from "node:path";

import type { FileEntry } from "@/lib/types";
import { subagentsOf, type SubagentBadge } from "@/components/scheme/subagentBadgeModel";
import { layoutBadges } from "@/components/scheme/subagentBadgeLayout";

const OUT_DIR = path.dirname(new URL(import.meta.url).pathname);

/* ── Synthetic conversation tree (invented; no private data) ─────────────── */
function entry(over: Partial<FileEntry> & { path: string; conversationId: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: over.path,
    project: "atlas-demo",
    title: over.title ?? over.conversationId,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: over.parent ?? null,
    mtime: over.mtime ?? 1,
    size: 1,
    activity: over.activity ?? "recent",
    proc: over.proc ?? null,
    pid: null,
    model: over.model ?? null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

const parent = entry({ path: "/atlas/parent", conversationId: "conv-parent", title: "Refactor billing module" });
const children: FileEntry[] = [
  entry({ path: "/atlas/migrate", conversationId: "conv-migrate", parent: parent.path, title: "Schema migration", proc: "running", activity: "live", sessionStartedAt: "2100-01-02T09:00:00Z" }),
  entry({ path: "/atlas/tests", conversationId: "conv-tests", parent: parent.path, title: "API contract tests", activity: "live", sessionStartedAt: "2100-01-02T09:20:00Z" }),
  entry({ path: "/atlas/docs", conversationId: "conv-docs", parent: parent.path, title: "Docs sweep", proc: "done", activity: "idle", sessionStartedAt: "2100-01-02T08:30:00Z" }),
  /* A stale earlier generation of the migration child sorts first in file order
     but must never be the navigation target — the current generation below wins. */
  entry({ path: "/atlas/migrate-gen1", conversationId: "conv-migrate", parent: parent.path, title: "Schema migration", generation: 1, mtime: 2 }),
];
const currentMigrate = entry({ path: "/atlas/migrate-gen2", conversationId: "conv-migrate", parent: parent.path, title: "Schema migration", generation: 2, mtime: 9, proc: "running", activity: "live", sessionStartedAt: "2100-01-02T09:00:00Z" });

const badges = subagentsOf("conv-parent", [children[3]!, currentMigrate, children[1]!, children[2]!, parent]);

/* ── Small deterministic avatar helpers (synthetic) ─────────────────────── */
function hue(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
function initials(title: string): string {
  const w = title.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w.at(-1)![0]! : w[0]?.slice(0, 2) || "AI").toUpperCase();
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function avatar(cx: number, cy: number, badge: SubagentBadge): string {
  const h = hue(badge.avatarSeed);
  const dim = badge.state === "closed" || badge.state === "dead" ? 0.45 : 1;
  return `
    <g opacity="${dim}">
      <circle cx="${cx}" cy="${cy}" r="15" fill="hsl(${h} 62% 55%)" stroke="#fff" stroke-width="1.5"/>
      <text x="${cx}" y="${cy + 3}" font-family="Inter, system-ui, sans-serif" font-size="9" font-weight="800" fill="#fff" text-anchor="middle">${esc(initials(badge.title))}</text>
      ${badge.state === "running" ? `<circle cx="${cx}" cy="${cy}" r="17.5" fill="none" stroke="#16a34a" stroke-width="2" opacity="0.8"/>` : ""}
    </g>`;
}
function expandedPill(x: number, y: number, badge: SubagentBadge): string {
  const h = hue(badge.avatarSeed);
  return `
    <g>
      <rect x="${x}" y="${y}" width="220" height="30" rx="15" fill="#ffffff" stroke="#c7cbd1" stroke-width="1"/>
      <circle cx="${x + 15}" cy="${y + 15}" r="15" fill="hsl(${h} 62% 55%)"/>
      <text x="${x + 15}" y="${y + 18}" font-family="Inter, system-ui, sans-serif" font-size="9" font-weight="800" fill="#fff" text-anchor="middle">${esc(initials(badge.title))}</text>
      <text x="${x + 38}" y="${y + 19}" font-family="Inter, system-ui, sans-serif" font-size="11.5" font-weight="700" fill="#1f2430">${esc(badge.title)}</text>
    </g>`;
}

/* ── Desktop still: card + right-edge bottom-up rail + structural arrow ──── */
function desktopSvg(): string {
  const W = 1040, H = 600;
  const card = { x: 60, y: 90, w: 600, h: 360 };
  const placed = layoutBadges(badges, card);
  const expandIdx = 1; // the live "API contract tests" badge, disclosed on hover
  const parts: string[] = [];
  // Structural arrow: badge0 fixed 30px center → a child card below (edge anchoring).
  const b0 = placed.find((p) => p.kind === "badge");
  if (b0 && b0.kind === "badge") {
    const ax = b0.x + b0.size / 2, ay = b0.y + b0.size / 2;
    const tx = 360, ty = 470;
    const lift = Math.max(36, (ty - ay) * 0.5);
    parts.push(`<path d="M ${ax} ${ay} C ${ax} ${ay + lift}, ${tx} ${ty - lift}, ${tx} ${ty - 7}" fill="none" stroke="#16a34a" stroke-width="2.5" opacity="0.85"/>`);
    parts.push(`<circle cx="${ax}" cy="${ay}" r="3.5" fill="#16a34a"/>`);
    parts.push(`<rect x="${tx - 150}" y="${ty}" width="300" height="70" rx="10" fill="#fff" stroke="#c7cbd1"/>`);
    parts.push(`<text x="${tx}" y="${ty + 40}" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="700" fill="#556" text-anchor="middle">Schema migration (child)</text>`);
  }
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]!;
    if (p.kind === "overflow") {
      parts.push(`<circle cx="${p.x + 15}" cy="${p.y + 15}" r="15" fill="#eef0f3" stroke="#c7cbd1"/><text x="${p.x + 15}" y="${p.y + 19}" font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="800" fill="#556" text-anchor="middle">+${p.count}</text>`);
      continue;
    }
    if (i === expandIdx) parts.push(expandedPill(p.x, p.y, p.child));
    else parts.push(avatar(p.x + 15, p.y + 15, p.child));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#f4f5f7"/>
    <text x="${card.x}" y="60" font-family="Inter, system-ui, sans-serif" font-size="16" font-weight="800" fill="#1f2430">PR #441 · desktop board — 30×30 bottom-up subagent badges, hover disclosure, edge anchoring</text>
    <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="12" fill="#ffffff" stroke="#c7cbd1"/>
    <rect x="${card.x}" y="${card.y}" width="${card.w}" height="6" rx="3" fill="#6366f1"/>
    <text x="${card.x + 20}" y="${card.y + 44}" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="800" fill="#1f2430">${esc(parent.title)}</text>
    <text x="${card.x + 20}" y="${card.y + 70}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#889">codex · atlas-demo (synthetic)</text>
    ${parts.join("\n")}
  </svg>`;
}

/* ── Mobile 390px still: phone chrome + left-edge bottom-up rail ─────────── */
function mobileSvg(): string {
  const W = 390, H = 844;
  const railH = 12 * 36;
  const card = { x: 0, y: 0, w: 0, h: railH };
  const placed = layoutBadges(badges, card);
  const originX = 8, originY = H - 80 - railH; // left-2, bottom-20 container
  const expandIdx = 0; // the running "Schema migration" badge, disclosed on tap
  const parts: string[] = [];
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]!;
    if (p.kind !== "badge") continue;
    const bx = originX + p.x, by = originY + p.y;
    if (i === expandIdx) parts.push(expandedPill(bx, by, p.child));
    else parts.push(avatar(bx + 15, by + 15, p.child));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#f4f5f7"/>
    <!-- top navigation strip -->
    <rect x="0" y="0" width="${W}" height="44" fill="#ffffff" stroke="#e3e5e9"/>
    <rect x="10" y="9" width="120" height="26" rx="13" fill="#eef0ff" stroke="#c3c8f5"/>
    <text x="24" y="26" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="700" fill="#4b52c7">● Billing</text>
    <rect x="140" y="9" width="70" height="26" rx="13" fill="#f2f3f5" stroke="#d7dade"/>
    <text x="152" y="26" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="600" fill="#889">⤷ codex</text>
    <!-- focused conversation pane -->
    <rect x="6" y="50" width="${W - 12}" height="${H - 130}" rx="10" fill="#ffffff" stroke="#e3e5e9"/>
    <text x="20" y="82" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="800" fill="#1f2430">${esc(parent.title)}</text>
    <text x="20" y="104" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#889">Focused conversation · 390px (synthetic)</text>
    <text x="20" y="150" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#556">Transcript…</text>
    <!-- composer -->
    <rect x="6" y="${H - 80}" width="${W - 12}" height="56" rx="12" fill="#fbfbfc" stroke="#e3e5e9"/>
    <text x="20" y="${H - 47}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#aab">Message…</text>
    <text x="20" y="740" font-family="Inter, system-ui, sans-serif" font-size="10.5" font-weight="700" fill="#4b52c7" text-anchor="start"> </text>
    <!-- subagent badge rail (left edge, bottom-up, clears composer) -->
    ${parts.join("\n")}
  </svg>`;
}

function render(name: string, svg: string): void {
  const svgPath = path.join(OUT_DIR, `${name}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`wrote ${path.relative(process.cwd(), svgPath)}`);
}

render("pr-441-desktop-badges", desktopSvg());
render("pr-441-mobile-390", mobileSvg());
console.log("badge order:", badges.map((b) => `${b.id}:${b.state}:${b.path}`).join(", "));
