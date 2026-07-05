import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { attentionId } from "@/components/attention";

import type { FileEntry } from "./types";

const STATE_DIR = path.join(os.homedir(), ".claude", "viewer-state");
const KEYS_FILE = path.join(STATE_DIR, "push-keys.json");
const SUBS_FILE = path.join(STATE_DIR, "push-subscriptions.json");
const SENT_FILE = path.join(STATE_DIR, "push-sent.json");
const WAITING_PUSH_DEBOUNCE_SECONDS = 60;
const PUSH_TIMEOUT_MS = 3_000;

interface Keys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime?: number | null;
  keys?: { p256dh?: string; auth?: string };
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
}

type PushResult = "sent" | "dead" | "failed";

let notifyChain = Promise.resolve();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function readJson<T>(pathname: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(pathname: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, JSON.stringify(value, null, 2));
    return true;
  } catch {
    return false;
  }
}

function hkdfExpand(prk: Buffer, info: Buffer | string, length: number): Buffer {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(chunks).length < length) {
    previous = crypto.createHmac("sha256", prk).update(previous).update(info).update(Buffer.from([counter])).digest();
    chunks.push(previous);
    counter += 1;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

export function pushKeys(): Keys {
  const existing = readJson<Keys | null>(KEYS_FILE, null);
  if (existing?.publicKey && existing.privateKey) return existing;
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = b64url(pair.publicKey.export({ type: "spki", format: "der" }).subarray(-65));
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keys = { publicKey, privateKey };
  writeJson(KEYS_FILE, keys);
  return keys;
}

async function saveSubscriptionNow(subscription: PushSubscriptionRecord): Promise<void> {
  if (!subscription.endpoint) return;
  const items = readJson<PushSubscriptionRecord[]>(SUBS_FILE, []).filter((item) => item.endpoint !== subscription.endpoint);
  items.push(subscription);
  writeJson(SUBS_FILE, items);
}

export async function saveSubscription(subscription: PushSubscriptionRecord): Promise<void> {
  notifyChain = notifyChain.then(() => saveSubscriptionNow(subscription), () => saveSubscriptionNow(subscription));
  await notifyChain.catch(() => undefined);
}

function vapidJwt(audience: string): string {
  const keys = pushKeys();
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:agent-log-viewer@localhost" }));
  const sign = crypto.createSign("SHA256");
  sign.update(`${header}.${body}`);
  sign.end();
  const signature = sign.sign({ key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64url(signature)}`;
}

function encryptPayload(subscription: PushSubscriptionRecord, payload: PushPayload): Buffer | null {
  const receiverKey = subscription.keys?.p256dh;
  const authSecret = subscription.keys?.auth;
  if (!receiverKey || !authSecret) return null;
  const receiverPublic = b64urlDecode(receiverKey);
  const auth = b64urlDecode(authSecret);
  const salt = crypto.randomBytes(16);
  const sender = crypto.createECDH("prime256v1");
  const senderPublic = sender.generateKeys();
  const shared = sender.computeSecret(receiverPublic);

  const prkKey = crypto.createHmac("sha256", auth).update(shared).digest();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const cek = hkdfExpand(prk, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdfExpand(prk, "Content-Encoding: nonce\0", 12);
  const plain = Buffer.concat([Buffer.from(JSON.stringify(payload), "utf8"), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, encrypted]);
}

async function sendPush(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<PushResult> {
  try {
    const body = encryptPayload(subscription, payload);
    if (!body) return "failed";
    const requestBody = new Uint8Array(body.byteLength);
    requestBody.set(body);
    const url = new URL(subscription.endpoint);
    const token = vapidJwt(url.origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `vapid t=${token}, k=${pushKeys().publicKey}`,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "60",
        urgency: "normal",
      },
      body: requestBody.buffer as ArrayBuffer,
    }).catch(() => null);
    clearTimeout(timer);
    if (!res) return "failed";
    if (res.status >= 200 && res.status < 300) return "sent";
    if (res.status === 404 || res.status === 410) return "dead";
    return "failed";
  } catch {
    return "failed";
  }
}

function payloadFor(entry: FileEntry): PushPayload {
  const header =
    entry.pendingQuestion?.kind === "plan"
      ? "plan awaiting approval"
      : entry.pendingQuestion?.questions?.[0]?.header ||
        entry.waitingInput?.menu?.question.slice(0, 120) ||
        (entry.waitingInput ? "waiting for an answer" : "question");
  return {
    title: `${entry.title || "Агент"} · ${entry.engine}`,
    body: header,
    url: `/#f=${encodeURIComponent(entry.path)}#question`,
  };
}

async function notifyQuestionNow(entry: FileEntry): Promise<void> {
  if (entry.waitingInput && Date.now() / 1000 - entry.waitingInput.since < WAITING_PUSH_DEBOUNCE_SECONDS) return;
  /* Push is deliberately narrower than the attention queue: hard-blocked
     events only, never stalled — the guard precedes the shared derivation. */
  if (!entry.pendingQuestion && !entry.waitingInput) return;
  const id = attentionId(entry);
  if (!id) return;
  const sent = new Set(readJson<string[]>(SENT_FILE, []));
  if (sent.has(id)) return;
  const subscriptions = readJson<PushSubscriptionRecord[]>(SUBS_FILE, []);
  if (!subscriptions.length) return;
  const alive: PushSubscriptionRecord[] = [];
  let delivered = false;
  let changed = false;
  const payload = payloadFor(entry);
  for (const subscription of subscriptions) {
    const result = await sendPush(subscription, payload);
    if (result === "sent") {
      delivered = true;
      alive.push(subscription);
    } else if (result === "failed") {
      alive.push(subscription);
    } else {
      changed = true;
    }
  }
  if (delivered) {
    sent.add(id);
    writeJson(SENT_FILE, [...sent].slice(-500));
  }
  if (changed) writeJson(SUBS_FILE, alive);
}

export async function notifyQuestion(entry: FileEntry): Promise<void> {
  notifyChain = notifyChain.then(() => notifyQuestionNow(entry), () => notifyQuestionNow(entry));
  await notifyChain.catch(() => undefined);
}
