"use client";

import { useEffect, useState } from "react";

/* Lazy syntax highlighting (issue #9 §7). highlight.js *core* plus the approved
   small language set load as ONE dynamic-import chunk, resolved only on the
   first expanded code body — the chunk is absent from the network until then.
   A block over the per-block cap, or an unknown language, stays plain mono. */

const HIGHLIGHT_MAX = 50_000;

type HljsCore = {
  registerLanguage: (name: string, lang: unknown) => void;
  highlight: (code: string, opts: { language: string; ignoreIllegal?: boolean }) => { value: string };
  getLanguage: (name: string) => unknown;
};

/* File extension / fence hint → canonical highlight.js language. Anything not
   listed (including diff/patch, which we render structurally) yields null. */
const LANG_ALIAS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  py: "python",
  python: "python",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "css",
  go: "go",
  html: "xml",
  xml: "xml",
  svg: "xml",
};

export function resolveLang(lang?: string | null): string | null {
  if (!lang) return null;
  return LANG_ALIAS[lang.toLowerCase()] ?? null;
}

let enginePromise: Promise<HljsCore | null> | null = null;

async function loadEngine(): Promise<HljsCore | null> {
  try {
    const core = (await import("highlight.js/lib/core")).default as unknown as HljsCore;
    const [ts, js, json, bash, python, markdown, yaml, css, go, xml] = await Promise.all([
      import("highlight.js/lib/languages/typescript"),
      import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/bash"),
      import("highlight.js/lib/languages/python"),
      import("highlight.js/lib/languages/markdown"),
      import("highlight.js/lib/languages/yaml"),
      import("highlight.js/lib/languages/css"),
      import("highlight.js/lib/languages/go"),
      import("highlight.js/lib/languages/xml"),
    ]);
    core.registerLanguage("typescript", ts.default);
    core.registerLanguage("javascript", js.default);
    core.registerLanguage("json", json.default);
    core.registerLanguage("bash", bash.default);
    core.registerLanguage("python", python.default);
    core.registerLanguage("markdown", markdown.default);
    core.registerLanguage("yaml", yaml.default);
    core.registerLanguage("css", css.default);
    core.registerLanguage("go", go.default);
    core.registerLanguage("xml", xml.default);
    return core;
  } catch {
    return null;
  }
}

/** Module-level singleton: the chunk resolves at most once per session. */
function getEngine(): Promise<HljsCore | null> {
  if (!enginePromise) enginePromise = loadEngine();
  return enginePromise;
}

/**
 * Returns highlighted HTML for `code`, or null (plain mono) while loading, when
 * the language is unknown, or when the block exceeds the per-block cap.
 */
export function useHighlighted(code: string, lang?: string | null): string | null {
  /* The result is tagged with the code it was computed for, so a stale async
     result never paints and no state is set synchronously in the effect
     (the plain fallback is simply the derived null below). */
  const [done, setDone] = useState<{ code: string; html: string } | null>(null);
  useEffect(() => {
    const language = resolveLang(lang);
    if (!language || code.length > HIGHLIGHT_MAX) return;
    let cancelled = false;
    void getEngine().then((core) => {
      if (cancelled || !core || !core.getLanguage(language)) return;
      try {
        const html = core.highlight(code, { language, ignoreIllegal: true }).value;
        if (!cancelled) setDone({ code, html });
      } catch {
        /* unknown grammar edge → leave plain */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return done && done.code === code ? done.html : null;
}
