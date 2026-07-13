"use client";

import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

function b64ToBytes(value: string): ArrayBuffer {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out.buffer.slice(0);
}

export function PushBell() {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const ok = "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;
    queueMicrotask(() => setSupported(ok));
    if (!ok) return;
    void navigator.serviceWorker.getRegistration("/question-push-sw.js").then((registration) =>
      registration?.pushManager.getSubscription().then((subscription) => setEnabled(subscription !== null)),
    );
  }, []);

  const toggle = async () => {
    if (!supported) return;
    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
    }
    if (Notification.permission !== "granted") return;
    const registration = await navigator.serviceWorker.register("/question-push-sw.js");
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
      setEnabled(false);
      return;
    }
    const keys = (await (await fetch("/api/push")).json()) as { publicKey: string };
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(keys.publicKey),
    });
    await fetch("/api/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    });
    setEnabled(true);
  };

  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted hover:text-primary disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "h-11 w-11" : "h-[26px] w-[26px]"
      }`}
      title={supported ? (enabled ? t("push.enabled") : t("push.enable")) : t("push.needsHttps")}
      aria-label={supported ? (enabled ? t("push.disable") : t("push.enable")) : t("push.needsHttps")}
      aria-pressed={enabled}
      disabled={!supported}
      onClick={toggle}
    >
      {enabled ? <Bell className="h-3.5 w-3.5" aria-hidden /> : <BellOff className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
