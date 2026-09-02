"use client";

import { Command, MessageCircle, Sparkle } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

import { engineBadge } from "../utils";

/*
 * The engine mark that rides the phone's meta lines (docs/design/mobile-v2/
 * README.md §3.2): `dot · state phrase · ENGINE GLYPH · model · reasoning`.
 *
 * The glyph carries the engine and the model name carries the model, so the
 * line never spends a word on what a 13 px mark already says — the strip's
 * "Claude · Claude · Claude" is exactly what the bar must not become. It is
 * decoration beside text that already names the engine's model, so it is
 * hidden from the accessibility tree rather than labelled twice.
 */
export function ChatEngineMark({ file }: { file: FileEntry }) {
  const Icon = file.engine === "codex" ? Command : file.engine === "openclaw" ? MessageCircle : Sparkle;
  return <Icon data-mobile2-engine={file.engine} className="h-3.5 w-3.5 shrink-0" style={{ color: engineBadge(file).style.color }} aria-hidden />;
}
