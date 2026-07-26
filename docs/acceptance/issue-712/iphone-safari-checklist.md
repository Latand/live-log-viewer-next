# Issue #712 — «Keep screen awake» manual acceptance on iPhone Safari

**Status: NOT PERFORMED.** No physical iPhone was available to the agent that
built this change, so every box below is open. Nothing in this document may be
read as a device pass. What *is* verified, and how, is listed under
[Already verified without a device](#already-verified-without-a-device).

The Screen Wake Lock API cannot be exercised faithfully by a headless engine:
the whole point of the feature is what the physical display does after the
Auto-Lock timer expires. That is a human check, and it has to happen on the
operator's own phone against the real deployment.

## Preconditions

- iPhone running the current iOS/Safari the operator actually uses; note the
  exact iOS and Safari version in the results table.
- The Viewer reached over **HTTPS**. Screen Wake Lock is secure-context only —
  over plain HTTP the control is deliberately inert and explains why, so an HTTP
  test proves nothing about the happy path.
- **Settings → Display & Brightness → Auto-Lock** set to its shortest value (30
  seconds) so each timing check takes half a minute instead of five.
- Low Power Mode **off** for the first pass. iOS suppresses some wake behaviour
  under Low Power Mode; test it separately (case 9) rather than mixing it in.

## Where the control is

Phone-width board → project header → **«⋯» (More actions)** menu → the
**«Keep screen awake»** row, directly under «Sound alerts». It is inside the menu
by design: the 390px header row has no width for a sixth 44px target (issue
#613), and the focused conversation must not lose height to a setting the
operator touches once.

## Checklist

Record each case as pass/fail with the caption text observed, not just a tick.

| # | Case | Steps | Expected | Result |
|---|------|-------|----------|--------|
| 1 | Control is reachable and tappable | Open the «⋯» menu on a phone-width board. | The row is present, the switch is a comfortable one-thumb target, and the caption reads that the screen sleeps on the device's usual timer. | ☐ |
| 2 | One explicit enable holds the screen | Tap the switch. Put the phone down, do not touch the screen, wait past the 30 s Auto-Lock. | The switch reads on, the caption says the screen stays awake **and names the battery cost**, and the display never dims or locks. | ☐ |
| 3 | Truthful active state | While case 2 holds, re-open the «⋯» menu. | The caption still claims the screen is held — and it genuinely is. Any other caption while the display stays on is a **fail** (the state must be truthful in both directions). | ☐ |
| 4 | Persistence across reload | With it enabled, pull-to-refresh / reload the tab. | The switch comes back on with no second tap, and the screen is held again. | ☐ |
| 5 | Persistence across a cold Safari start | Force-quit Safari, reopen it, return to the Viewer. | Same as case 4. | ☐ |
| 6 | Backgrounding releases, returning re-acquires | Swipe to the home screen (or switch apps) for ~10 s, then return to the tab. | While away the caption reads paused-and-will-resume; on return it reads held again, and the screen stops locking again. | ☐ |
| 7 | System release is surfaced, never hidden | Provoke a release iOS does on its own — take a call, trigger a system alert, or let the tab sit backgrounded for several minutes — then return. | Either the lock is re-acquired (caption: held) or the caption says the system released it. It must **never** claim the screen is held while the display is dimming. | ☐ |
| 8 | Disable releases immediately | Tap the switch off, put the phone down. | The caption returns to the sleeps-normally line and Auto-Lock dims the display on schedule. | ☐ |
| 9 | Low Power Mode | Enable Low Power Mode, repeat case 2. | Whatever iOS does, the caption must match reality: if the lock does not stick, the row says so instead of claiming the screen is held. Record the observed behaviour — this is the case most likely to differ by iOS version. | ☐ |
| 10 | Home Screen / PWA mode (if the operator uses it) | Add the Viewer to the Home Screen, launch from that icon, repeat cases 2, 4 and 6. | Identical behaviour to the Safari tab. Note any difference — standalone mode has its own lifecycle and is worth its own row. | ☐ |
| 11 | Plain HTTP is explained, not dead | Reach the Viewer over `http://` (e.g. the LAN address). | The switch is inert and the caption names the HTTPS requirement. No silent dead toggle. | ☐ |
| 12 | Battery honesty | Note the battery percentage before and after ~20 minutes of case 2. | The drain is visibly higher than with the screen sleeping — which is exactly what the caption warns about. Record the numbers so the warning is grounded. | ☐ |
| 13 | Nothing leaks off the device | After enabling, confirm no server-side or transcript trace of the preference. | The intent lives only in this device's `localStorage`; the board, presence payloads and transcripts are unchanged. | ☐ |

## Results

| iOS / Safari version | Mode (tab / Home Screen) | Date | Cases passed | Notes |
|---|---|---|---|---|
| _to be filled by the operator_ | | | | |

## Already verified without a device

These are machine-checked and green; they are what makes the manual pass a
confirmation rather than a discovery.

- `src/hooks/useScreenWakeLock.test.ts` — the controller seam over a fully
  injected Wake Lock API: acquire, release on disable, release on hide,
  re-acquire on return, persisted intent restored on the next visit, unsupported,
  insecure context, refused and failed requests, a system release recovered once
  then reported, and the races that could otherwise leave two sentinels held.
  Mutation-checked: deleting the visibility sync, the release, or the acquire
  each turns cases red.
- `src/components/KeepAwakeControl.dom.test.tsx` — the React seam: the switch's
  44px geometry and accessible naming, one owner even when the provider is
  nested, `visibilitychange` **and** `pageshow` re-acquisition, unmount releasing
  the sentinel and unhooking its listeners, and every state's caption.
- `src/components/mobile/mobileHeaderFit.dom.test.tsx` — the row is one tap
  inside the «⋯» menu, holds a real sentinel from there, and adds **zero**
  controls to the 390px header row.
- `src/components/mobile/issue613Evidence.browser.test.tsx` — the real Chromium
  390px header geometry still fits, measured against the production CSS.

What none of them can prove: that a physical iPhone display stays lit. That is
cases 1–13 above.
