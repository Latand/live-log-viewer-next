"use client";

import { SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { ambientLoopAvailable, ensureAmbientLoop, playCue } from "@/lib/audio/app";
import { setAudioPrefs, useAudioPrefs, watchAudioPrefsStorage } from "@/lib/audio/prefs";
import { useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

/**
 * The header's sound cluster: the master switch, and the levels behind it.
 *
 * The master governs ALL product audio — the semantic earcons and the
 * background music alike. One switch, because a mute that leaves something still
 * making noise is the mute people remember. Everything here is DEVICE-LOCAL: the
 * phone in the kitchen and the desk keep their own answers, which is the whole
 * reason none of this is server state.
 *
 * The music rows appear only when a loop asset is actually configured. With no
 * asset there is nothing to enable, and a toggle that cannot do anything is
 * worse than an absent one.
 */
export function SoundToggle({ ambientAvailable }: { ambientAvailable?: boolean } = {}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const prefs = useAudioPrefs();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /* Overridable so the no-asset rendering — a supported state — stays testable
     without mocking the audio module out from under the component. */
  const ambient = ambientAvailable ?? ambientLoopAvailable();

  /* Another tab on this device is the same device: adopt its choice. */
  useEffect(() => (typeof window === "undefined" ? undefined : watchAudioPrefsStorage(window)), []);

  const size = isMobile ? "h-11 w-11" : "h-[26px] w-[26px]";
  const glyph = isMobile ? "h-5 w-5" : "h-3.5 w-3.5";

  const toggleMaster = () => {
    const cuesEnabled = !prefs.cuesEnabled;
    setAudioPrefs({ cuesEnabled });
    /* Turning sound on previews what the operator just asked for; the bed picks
       itself back up if a call is already live. */
    if (cuesEnabled) playCue({ cue: "success", eventId: `preview:${Date.now()}` });
    ensureAmbientLoop();
  };

  const setLevel = (patch: { cueVolume: number } | { loopVolume: number }) => {
    setAudioPrefs(patch);
    ensureAmbientLoop();
  };

  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1">
      <button
        className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${size}`}
        title={prefs.cuesEnabled ? t("sound.on") : t("sound.off")}
        aria-label={prefs.cuesEnabled ? t("sound.mute") : t("sound.unmute")}
        aria-pressed={prefs.cuesEnabled}
        onClick={toggleMaster}
      >
        {prefs.cuesEnabled
          ? <Volume2 className={glyph} aria-hidden />
          : <VolumeX className={glyph} aria-hidden />}
      </button>

      <span className="relative inline-flex">
        <button
          ref={trigger}
          data-testid="sound-settings-trigger"
          className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${size}`}
          title={t("sound.settings")}
          aria-label={t("sound.settings")}
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <SlidersHorizontal className={glyph} aria-hidden />
        </button>

        {open ? (
          <div
            ref={panel}
            data-testid="sound-settings"
            role="dialog"
            aria-label={t("sound.settings")}
            onKeyDown={(event) => {
              handleOverlayEscape(event, () => {
                setOpen(false);
                trigger.current?.focus();
              });
            }}
            className="absolute right-0 top-full z-50 mt-1 w-56 space-y-2 rounded-control border border-border bg-card p-2 shadow-2"
          >
            <label className="block space-y-1">
              <span className="block text-[11px] font-semibold text-secondary">{t("sound.cueVolume")}</span>
              <input
                type="range"
                data-testid="cue-volume"
                min={0}
                max={1}
                step={0.05}
                value={prefs.cueVolume}
                aria-label={t("sound.cueVolume")}
                onChange={(event) => setLevel({ cueVolume: Number(event.target.value) })}
                className="w-full accent-accent"
              />
            </label>

            {/* No asset, no rows. */}
            {ambient ? (
              <>
                {/* Two independent switches, one shared level: music in the
                    Viewer and music during a call compose freely, and with both
                    on it is one track across the call boundary. */}
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="ambient-viewer-enabled"
                    checked={prefs.viewerLoopEnabled}
                    onChange={(event) => {
                      setAudioPrefs({ viewerLoopEnabled: event.target.checked });
                      ensureAmbientLoop();
                    }}
                    className="accent-accent"
                  />
                  <span className="text-[11px] font-semibold text-secondary">{t("sound.ambientViewer")}</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="ambient-enabled"
                    checked={prefs.loopEnabled}
                    onChange={(event) => {
                      setAudioPrefs({ loopEnabled: event.target.checked });
                      ensureAmbientLoop();
                    }}
                    className="accent-accent"
                  />
                  <span className="text-[11px] font-semibold text-secondary">{t("sound.ambient")}</span>
                </label>
                <label className="block space-y-1">
                  <span className="block text-[11px] text-muted">{t("sound.ambientVolume")}</span>
                  <input
                    type="range"
                    data-testid="ambient-volume"
                    min={0}
                    max={1}
                    step={0.05}
                    value={prefs.loopVolume}
                    aria-label={t("sound.ambientVolume")}
                    onChange={(event) => setLevel({ loopVolume: Number(event.target.value) })}
                    className="w-full accent-accent"
                  />
                </label>
                <p className="text-[10.5px] leading-snug text-muted">{t("sound.ambientHint")}</p>
              </>
            ) : null}
          </div>
        ) : null}
      </span>
    </span>
  );
}
