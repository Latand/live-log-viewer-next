"use client";

import { stripLineSuffix, type ArtifactKind } from "@/lib/artifact/classify";

/** What /api/artifact?mode=meta answers: identity, never contents. */
export interface ArtifactMeta {
  name: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  mtimeMs: number;
  etag: string;
}

export type ArtifactFailure =
  | "missing"
  | "denied"
  | "unsupported"
  | "oversized"
  | "changed"
  | "aborted"
  | "error";

export function artifactContentUrl(path: string, options: { download?: boolean } = {}): string {
  const query = new URLSearchParams({ path: stripLineSuffix(path) });
  if (options.download) query.set("download", "1");
  return `/api/artifact?${query.toString()}`;
}

export function artifactMetaUrl(path: string): string {
  const query = new URLSearchParams({ path: stripLineSuffix(path), mode: "meta" });
  return `/api/artifact?${query.toString()}`;
}

export function failureFromStatus(status: number): ArtifactFailure {
  if (status === 404) return "missing";
  if (status === 403) return "denied";
  if (status === 415) return "unsupported";
  if (status === 413) return "oversized";
  if (status === 412) return "changed";
  return "error";
}

/** The display basename of a linked path — never the full path (titles must
    not leak directory structure into screenshots/screen readers). */
export function artifactBasename(path: string): string {
  return stripLineSuffix(path).split("/").pop() || path;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
