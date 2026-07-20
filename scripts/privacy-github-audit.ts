import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import {
  canonicalSensitiveText,
  type FindingClass,
  inspectPaths,
  reportPrivacyFindings,
  sensitiveClasses,
} from "./privacy-publication-gate";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GithubAuditOptions = {
  apiUrl?: string;
  fetcher?: FetchLike;
  number: number;
  repo: string;
  requireKnownValues?: boolean;
  token: string;
};

type GithubIssue = {
  body?: unknown;
  pull_request?: unknown;
  title?: unknown;
};

type GithubSurface = {
  body?: unknown;
  title?: unknown;
};

const trustedMediaHosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
]);
const contentTypeExtensions: Record<string, string> = {
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};
const mediaExtensions = new Set([
  ".avi",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".png",
  ".tif",
  ".tiff",
  ".webm",
  ".webp",
]);

function addFinding(findings: Map<FindingClass, number>, finding: FindingClass, count = 1): void {
  findings.set(finding, (findings.get(finding) ?? 0) + count);
}

function mergeFindings(target: Map<FindingClass, number>, source: Map<FindingClass, number> | Set<FindingClass>): void {
  if (source instanceof Map) {
    for (const [finding, count] of source) addFinding(target, finding, count);
    return;
  }
  for (const finding of source) addFinding(target, finding);
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

function isTrustedUrl(url: URL, apiOrigin: string): boolean {
  if (url.origin === apiOrigin) return url.protocol === "https:" || isLocalHttp(url);
  return url.protocol === "https:" && trustedMediaHosts.has(url.hostname);
}

function usesAuthentication(url: URL, apiOrigin: string): boolean {
  return url.origin === apiOrigin || url.hostname === "github.com";
}

async function safeFetch(
  initialUrl: URL,
  token: string,
  apiOrigin: string,
  fetcher: FetchLike,
  accept: string,
): Promise<Response | undefined> {
  let url = initialUrl;
  for (let redirect = 0; redirect < 5; redirect += 1) {
    if (!isTrustedUrl(url, apiOrigin)) return undefined;
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "live-log-viewer-privacy-audit",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (usesAuthentication(url, apiOrigin)) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetcher(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return undefined;
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return undefined;
    try {
      url = new URL(location, url);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function fetchJson(
  url: URL,
  token: string,
  apiOrigin: string,
  fetcher: FetchLike,
): Promise<unknown | undefined> {
  const response = await safeFetch(url, token, apiOrigin, fetcher, "application/vnd.github+json");
  if (!response?.ok) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function fetchPages(
  apiBase: URL,
  pathname: string,
  token: string,
  fetcher: FetchLike,
): Promise<GithubSurface[] | undefined> {
  const surfaces: GithubSurface[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(pathname, apiBase);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", page.toString());
    const result = await fetchJson(url, token, apiBase.origin, fetcher);
    if (!Array.isArray(result)) return undefined;
    surfaces.push(...result as GithubSurface[]);
    if (result.length < 100) return surfaces;
  }
  return undefined;
}

function markdownImageDestinations(text: string): string[] {
  const destinations: string[] = [];
  const normalizeLabel = (label: string): string => label
    .replaceAll(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
  const labelEndFrom = (start: number): number => {
    for (let cursor = start; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\" && cursor + 1 < text.length) {
        cursor += 1;
        continue;
      }
      if (text[cursor] === "\r" || text[cursor] === "\n") return -1;
      if (text[cursor] === "]") return cursor;
    }
    return -1;
  };
  const definitions = new Map<string, string>();
  const definitionStartPattern = /^[ \t]{0,3}\[/gm;
  for (const definitionStart of text.matchAll(definitionStartPattern)) {
    const labelStart = (definitionStart.index ?? 0) + definitionStart[0].length;
    const labelEnd = labelEndFrom(labelStart);
    if (labelEnd === -1 || labelEnd === labelStart || text[labelEnd + 1] !== ":") continue;
    const destination = text.slice(labelEnd + 2).match(
      /^[ \t]*(?:(?:\r\n?|\n)[ \t]*)?(?:<([^>\r\n]+)>|([^\s\r\n]+))/,
    );
    if (!destination) continue;
    definitions.set(normalizeLabel(text.slice(labelStart, labelEnd)), destination[1] ?? destination[2]);
  }
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const imageStart = text.indexOf("![", searchFrom);
    if (imageStart === -1) break;
    let labelEnd = imageStart + 2;
    let labelDepth = 0;
    for (; labelEnd < text.length; labelEnd += 1) {
      if (text[labelEnd] === "\\" && labelEnd + 1 < text.length) {
        labelEnd += 1;
        continue;
      }
      if (text[labelEnd] === "[") labelDepth += 1;
      if (text[labelEnd] !== "]") continue;
      if (labelDepth === 0) break;
      labelDepth -= 1;
    }
    if (labelEnd >= text.length) break;
    const label = text.slice(imageStart + 2, labelEnd);
    if (text[labelEnd + 1] !== "(") {
      let referenceLabel = label;
      let nextSearchFrom = labelEnd + 1;
      if (text[labelEnd + 1] === "[") {
        const referenceEnd = labelEndFrom(labelEnd + 2);
        if (referenceEnd !== -1) {
          referenceLabel = text.slice(labelEnd + 2, referenceEnd) || label;
          nextSearchFrom = referenceEnd + 1;
        }
      }
      const destination = definitions.get(normalizeLabel(referenceLabel));
      if (destination) destinations.push(destination);
      searchFrom = nextSearchFrom;
      continue;
    }
    let cursor = labelEnd + 2;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] === "<") {
      const closing = text.indexOf(">", cursor + 1);
      if (closing !== -1) destinations.push(text.slice(cursor + 1, closing));
      searchFrom = closing === -1 ? cursor + 1 : closing + 1;
      continue;
    }
    let depth = 0;
    let destination = "";
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (character === "\\" && cursor + 1 < text.length) {
        destination += text[cursor + 1];
        cursor += 1;
        continue;
      }
      if (character === "(") {
        depth += 1;
        destination += character;
        continue;
      }
      if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
        destination += character;
        continue;
      }
      if (/\s/.test(character) && depth === 0) break;
      destination += character;
    }
    if (destination.length > 0) destinations.push(destination);
    searchFrom = Math.max(imageStart + 2, cursor + 1);
  }
  return destinations;
}

function srcsetDestinations(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter((candidate) => candidate.length > 0);
}

function htmlAttributes(text: string): Array<{ name: string; value: string }> {
  const attributes: Array<{ name: string; value: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (cursor < text.length && (/\s/.test(text[cursor]) || text[cursor] === "/")) cursor += 1;
    const nameStart = cursor;
    while (cursor < text.length && !/[\s/=]/.test(text[cursor])) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = text.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    let value = "";
    if (text[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      const quote = text[cursor] === "\"" || text[cursor] === "'" ? text[cursor] : undefined;
      if (quote) {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < text.length && text[cursor] !== quote) cursor += 1;
        value = text.slice(valueStart, cursor);
        if (text[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < text.length && !/\s/.test(text[cursor])) cursor += 1;
        value = text.slice(valueStart, cursor);
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function htmlMediaDestinations(text: string): string[] {
  const destinations: string[] = [];
  const mediaTags = /<(img|source|video)\b/gi;
  let tag: RegExpExecArray | null;
  while ((tag = mediaTags.exec(text)) !== null) {
    let quote: "\"" | "'" | undefined;
    let awaitingAttributeValue = false;
    let unquotedAttributeValue = false;
    let tagEnd = -1;
    for (let cursor = mediaTags.lastIndex; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quote) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (unquotedAttributeValue) {
        if (character === ">") {
          tagEnd = cursor;
          break;
        }
        if (/\s/.test(character)) unquotedAttributeValue = false;
        continue;
      }
      if (awaitingAttributeValue) {
        if (/\s/.test(character)) continue;
        awaitingAttributeValue = false;
        if (character === "\"" || character === "'") quote = character;
        else if (character === ">") {
          tagEnd = cursor;
          break;
        } else unquotedAttributeValue = true;
        continue;
      }
      if (character === ">") {
        tagEnd = cursor;
        break;
      }
      if (character === "=") awaitingAttributeValue = true;
    }
    if (tagEnd === -1) break;
    const tagName = tag[1].toLowerCase();
    const attributes = text.slice(mediaTags.lastIndex, tagEnd);
    for (const attribute of htmlAttributes(attributes)) {
      const { name } = attribute;
      const value = canonicalSensitiveText(attribute.value).text;
      const imageSource = (tagName === "img" || tagName === "source") && (name === "src" || name === "srcset");
      const videoSource = tagName === "video" && (name === "src" || name === "poster");
      if (imageSource || videoSource) {
        destinations.push(...(name === "srcset" ? srcsetDestinations(value) : [value]));
      }
    }
    mediaTags.lastIndex = tagEnd + 1;
  }
  return destinations;
}

function publishedMediaUrls(text: string, githubBase: URL): URL[] {
  const canonicalText = canonicalSensitiveText(text).text;
  const renderedCandidates = [
    ...markdownImageDestinations(text).map((destination) => canonicalSensitiveText(destination).text),
    ...htmlMediaDestinations(text),
  ];
  const candidates: string[] = [];
  for (const match of canonicalText.matchAll(/https?:\/\/[^\s<>"'\]]+/gi)) candidates.push(match[0]);
  const urls = new Map<string, URL>();
  for (const [candidate, rendered] of [
    ...renderedCandidates.map((value): [string, boolean] => [value, true]),
    ...candidates.map((value): [string, boolean] => [value, false]),
  ]) {
    let url: URL;
    try {
      let normalizedCandidate = candidate.replaceAll("&amp;", "&");
      while (normalizedCandidate.endsWith(")")) {
        const openings = [...normalizedCandidate].filter((character) => character === "(").length;
        const closings = [...normalizedCandidate].filter((character) => character === ")").length;
        if (closings <= openings) break;
        normalizedCandidate = normalizedCandidate.slice(0, -1);
      }
      url = new URL(normalizedCandidate, githubBase);
    } catch {
      continue;
    }
    const extension = extname(url.pathname).toLowerCase();
    const githubAsset = url.pathname.includes("/assets/") || url.pathname.includes("/user-attachments/");
    if (rendered || mediaExtensions.has(extension) || githubAsset || url.hostname.includes("user-images.githubusercontent.com")) {
      urls.set(url.href, url);
    }
  }
  return [...urls.values()];
}

function surfaceTexts(surfaces: GithubSurface[]): string[] {
  return surfaces.flatMap((surface) => [surface.title, surface.body]
    .filter((value): value is string => typeof value === "string" && value.length > 0));
}

export async function auditGithubPublication(options: GithubAuditOptions): Promise<Map<FindingClass, number>> {
  const findings = inspectPaths([], false, options.requireKnownValues ?? true);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)
    || !Number.isSafeInteger(options.number)
    || options.number < 1
    || options.token.length < 1) {
    addFinding(findings, "configuration_error");
    return findings;
  }
  let apiBase: URL;
  try {
    apiBase = new URL(options.apiUrl ?? "https://api.github.com/");
  } catch {
    addFinding(findings, "configuration_error");
    return findings;
  }
  if (!apiBase.pathname.endsWith("/")) apiBase.pathname += "/";
  if ((apiBase.protocol !== "https:" && !isLocalHttp(apiBase)) || apiBase.username || apiBase.password) {
    addFinding(findings, "configuration_error");
    return findings;
  }
  const fetcher = options.fetcher ?? fetch;
  const githubBase = new URL(`https://github.com/${options.repo}/`);
  const root = `repos/${options.repo}`;
  const issueResult = await fetchJson(
    new URL(`${root}/issues/${options.number}`, apiBase),
    options.token,
    apiBase.origin,
    fetcher,
  );
  if (typeof issueResult !== "object" || issueResult === null || Array.isArray(issueResult)) {
    addFinding(findings, "inspection_error");
    return findings;
  }
  const issue = issueResult as GithubIssue;
  const comments = await fetchPages(apiBase, `${root}/issues/${options.number}/comments`, options.token, fetcher);
  if (!comments) {
    addFinding(findings, "inspection_error");
    return findings;
  }
  const texts = new Set(surfaceTexts([issue, ...comments]));
  if (issue.pull_request) {
    const [pullResult, reviewComments, reviews] = await Promise.all([
      fetchJson(new URL(`${root}/pulls/${options.number}`, apiBase), options.token, apiBase.origin, fetcher),
      fetchPages(apiBase, `${root}/pulls/${options.number}/comments`, options.token, fetcher),
      fetchPages(apiBase, `${root}/pulls/${options.number}/reviews`, options.token, fetcher),
    ]);
    if (typeof pullResult !== "object" || pullResult === null || Array.isArray(pullResult) || !reviewComments || !reviews) {
      addFinding(findings, "inspection_error");
      return findings;
    }
    for (const text of surfaceTexts([pullResult as GithubSurface, ...reviewComments, ...reviews])) texts.add(text);
  }

  for (const text of texts) mergeFindings(findings, sensitiveClasses(text));

  const mediaUrls = new Map<string, URL>();
  for (const text of texts) {
    for (const url of publishedMediaUrls(text, githubBase)) mediaUrls.set(url.href, url);
  }
  if (mediaUrls.size === 0) return findings;

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "llv-privacy-github-audit-"));
  try {
    let index = 0;
    for (const url of mediaUrls.values()) {
      if (!isTrustedUrl(url, apiBase.origin)) {
        addFinding(findings, "inspection_error");
        continue;
      }
      const response = await safeFetch(url, options.token, apiBase.origin, fetcher, "image/*,video/*");
      const declaredLength = Number(response?.headers.get("content-length"));
      if (!response?.ok || (Number.isFinite(declaredLength) && declaredLength > 32 * 1024 * 1024)) {
        addFinding(findings, "inspection_error");
        continue;
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
      const extension = mediaExtensions.has(extname(url.pathname).toLowerCase())
        ? extname(url.pathname).toLowerCase()
        : contentTypeExtensions[contentType];
      if (!extension) {
        addFinding(findings, "inspection_error");
        continue;
      }
      let contents: Buffer;
      try {
        contents = Buffer.from(await response.arrayBuffer());
      } catch {
        addFinding(findings, "inspection_error");
        continue;
      }
      if (contents.length === 0 || contents.length > 32 * 1024 * 1024) {
        addFinding(findings, "inspection_error");
        continue;
      }
      const path = join(temporaryDirectory, `publication-${index}${extension}`);
      index += 1;
      writeFileSync(path, contents, { mode: 0o600 });
      mergeFindings(findings, inspectPaths([path]));
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
  return findings;
}

function argumentValue(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const number = Number(argumentValue(arguments_, "--number"));
  const findings = await auditGithubPublication({
    apiUrl: argumentValue(arguments_, "--api-url"),
    number,
    repo: argumentValue(arguments_, "--repo") ?? "",
    requireKnownValues: true,
    token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "",
  });
  reportPrivacyFindings(findings);
}
