/*
 * The ONE artifact-type authority for issue #875, shared by the transcript link
 * interceptor (client) and the /api/artifact resource route (server): a local
 * link previews if and only if the server would agree to serve it. Everything
 * here is derived from the basename alone — no I/O — so the client can decide
 * synchronously at render time.
 */

export type ArtifactKind = "pdf" | "image" | "text";

export interface ArtifactClass {
  kind: ArtifactKind;
  mime: string;
}

/* SVG joins the inert rasters ONLY because the route serves it under a
   sandboxing CSP with script-src 'none' and the preview embeds it via <img>,
   where embedded script never executes. See /api/artifact. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/* Bounded text/source formats. Always served as text/plain so nothing in this
   list can ever become an executing document on the app origin. `.jsonl` is
   deliberately absent: that extension is the conversation transcript format and
   must keep resolving as a `#f=` card deep-link, not a file preview. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "log", "json", "yaml", "yml", "toml", "ini", "conf",
  "csv", "tsv", "xml", "html", "htm", "css", "scss",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "rb", "php",
  "sh", "bash", "zsh", "fish", "sql", "diff", "patch",
]);

export const TEXT_MIME = "text/plain; charset=utf-8";

/** Strips the `path/to/file.ts:12` / `:12:7` location suffix agents emit. */
export function stripLineSuffix(path: string): string {
  return path.replace(/(:\d+){1,2}$/, "");
}

/**
 * Classifies a local path (or bare filename) as a previewable artifact, by
 * extension. Returns null for everything the preview must leave alone —
 * transcripts, unknown binaries, extensionless files, and dotfiles like `.env`
 * whose "extension" is really a hidden name.
 */
export function classifyArtifact(path: string): ArtifactClass | null {
  const base = stripLineSuffix(path).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const stem = base.slice(0, dot);
  /* `.env.local` and friends: a dot-led stem is a hidden config, not a doc. */
  if (stem.startsWith(".")) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!ext) return null;
  if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
  const image = IMAGE_MIME[ext];
  if (image) return { kind: "image", mime: image };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", mime: TEXT_MIME };
  return null;
}
