import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Validates the complete owner-only Telegram session pair. This module is
 * shared by the Viewer session store and the packaged tmux token reader so
 * both paths enforce the same directory, file, schema, and digest fence.
 *
 * @param {string} directory
 * @returns {
 *   | { status: "missing" }
 *   | { status: "unsafe"; detail: string }
 *   | { status: "valid"; sessionFile: { version: 1; credentialRef: string; sessionString: string; savedAt: string; connectorTokenSha256: string }; connectorToken: string }
 * }
 */
export function readValidatedTelegramSessionFiles(directory) {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  let directoryStat;
  try { directoryStat = fs.lstatSync(directory); }
  catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unsafe", detail: "cannot inspect telegram directory" };
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return { status: "unsafe", detail: "telegram directory is unsafe" };
  }
  if ((directoryStat.mode & 0o077) !== 0 || (expectedUid !== null && directoryStat.uid !== expectedUid)) {
    return { status: "unsafe", detail: "telegram directory ownership or permissions are unsafe" };
  }

  const sessionPath = path.join(directory, "session.json");
  const tokenPath = path.join(directory, "connector-token");
  let sessionStat;
  try { sessionStat = fs.lstatSync(sessionPath); }
  catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unsafe", detail: "cannot inspect session file" };
  }
  if (sessionStat.isSymbolicLink() || !sessionStat.isFile() || (sessionStat.mode & 0o077) !== 0
    || (expectedUid !== null && sessionStat.uid !== expectedUid)) {
    return { status: "unsafe", detail: "session file ownership or permissions are unsafe" };
  }

  let sessionFile;
  try { sessionFile = JSON.parse(fs.readFileSync(sessionPath, "utf8")); }
  catch { return { status: "unsafe", detail: "session data is unreadable" }; }
  if (!sessionFile || typeof sessionFile !== "object" || sessionFile.version !== 1
    || typeof sessionFile.credentialRef !== "string"
    || typeof sessionFile.sessionString !== "string" || !sessionFile.sessionString
    || typeof sessionFile.savedAt !== "string"
    || typeof sessionFile.connectorTokenSha256 !== "string") {
    return { status: "unsafe", detail: "session data is invalid" };
  }

  let tokenStat;
  try { tokenStat = fs.lstatSync(tokenPath); }
  catch { return { status: "unsafe", detail: "connector token is missing or unreadable" }; }
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0
    || (expectedUid !== null && tokenStat.uid !== expectedUid)) {
    return { status: "unsafe", detail: "connector token ownership or permissions are unsafe" };
  }
  let connectorToken;
  try { connectorToken = fs.readFileSync(tokenPath, "utf8").trim(); }
  catch { return { status: "unsafe", detail: "connector token is unreadable" }; }
  const tokenHash = crypto.createHash("sha256").update(connectorToken).digest("hex");
  if (!/^[A-Za-z0-9_-]{43}$/.test(connectorToken) || tokenHash !== sessionFile.connectorTokenSha256) {
    return { status: "unsafe", detail: "connector token is invalid" };
  }
  return { status: "valid", sessionFile, connectorToken };
}
