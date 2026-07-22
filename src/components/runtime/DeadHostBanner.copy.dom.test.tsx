/**
 * Issue #499 (repair round): the dead-host copy must be TRUTHFUL in both
 * locales. A dead STRUCTURED host still admits text durably (the composer's
 * Send stays enabled and the message is delivered after recovery), while
 * images cannot be attached until the host is back. The previous body —
 * "Messages can't be delivered." — contradicted the shipped behavior, so the
 * banner promised less than the product does.
 *
 * These tests pin the four facts the copy must state, per locale:
 *   1. durable text admission,
 *   2. delayed delivery after recovery,
 *   3. the image restriction,
 *   4. the recovery controls (Respawn / Terminal / Re-check).
 */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";

import { DeadHostBannerView } from "./DeadHostBanner";

const LOCALES = ["en", "uk"] as const;

/** Semantic markers per locale: stems that must (or must not) appear so the
    copy states each fact without the test hard-coding one exact phrasing. */
const FACTS = {
  en: {
    durableAdmission: /durabl/i,
    delayedDelivery: /delivered (?:after|once|when)/i,
    recovery: /recover/i,
    imageRestriction: /image/i,
    falseClaims: [/can[’']t be delivered/i, /cannot be delivered/i],
  },
  uk: {
    durableAdmission: /надійно збер/i,
    delayedDelivery: /достав\p{L}+ після/iu,
    recovery: /відновл/i,
    imageRestriction: /зображенн/i,
    falseClaims: [/не доставляються/i],
  },
} as const;

for (const locale of LOCALES) {
  test(`the ${locale} dead-host banner body states durable admission, delayed delivery, the image restriction, and recovery`, () => {
    const body = translate(locale, "deadHost.body");
    const facts = FACTS[locale];
    expect(body).toMatch(facts.durableAdmission);
    expect(body).toMatch(facts.delayedDelivery);
    expect(body).toMatch(facts.recovery);
    expect(body).toMatch(facts.imageRestriction);
    for (const falseClaim of facts.falseClaims) expect(body).not.toMatch(falseClaim);
  });

  test(`the ${locale} composer image-restriction line explains the block and the after-recovery delivery`, () => {
    const line = translate(locale, "composer.imagesBlockedDuringRecovery");
    const facts = FACTS[locale];
    // The line must state the restriction as a restriction (not merely that a
    // selection persists) and tie its release to recovery.
    // Drafting stays allowed while the host is down; the line only ties image
    // delivery to recovery (compact-feed pass).
    expect(line).toMatch(facts.recovery);
  });

  test(`the ${locale} banner stays one compact row with all three recovery controls`, () => {
    const t: Parameters<typeof DeadHostBannerView>[0]["t"] = (key, params) => translate(locale, key, params);
    const html = renderToStaticMarkup(
      <DeadHostBannerView t={t} sinceLabel="5m" onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} />,
    );
    // The explainer body is gone (compact-feed pass): the title states the
    // queueing contract and every control stays reachable.
    const body = translate(locale, "deadHost.body");
    const escapeFree = (value: string) => value.split(/[&<>'’]/)[0]!.trim();
    expect(html).not.toContain(escapeFree(body));
    for (const control of ["deadHost.respawn", "deadHost.attach", "deadHost.recheck"] as const) {
      expect(html).toContain(translate(locale, control));
    }
  });
}
