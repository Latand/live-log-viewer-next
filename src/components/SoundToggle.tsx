"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { chime, setSoundEnabled, soundEnabled } from "@/lib/chime";
import { useLocale } from "@/lib/i18n";

/** Header switch for the finish-chimes; turning it on plays a preview note. */
export function SoundToggle() {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [on, setOn] = useState(true);
  /* localStorage is client-only: read after mount to keep hydration clean. */
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setOn(soundEnabled()), []);
  const toggle = () => {
    const next = !on;
    setOn(next);
    setSoundEnabled(next);
    if (next) chime("returned", 0);
  };
  return (
    <button
      className={`ml-auto inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-panel text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "h-11 w-11" : "h-[26px] w-[26px]"
      }`}
      title={on ? t("sound.on") : t("sound.off")}
      aria-label={on ? t("sound.mute") : t("sound.unmute")}
      aria-pressed={on}
      onClick={toggle}
    >
      {on ? <Volume2 className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden /> : <VolumeX className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} aria-hidden />}
    </button>
  );
}
