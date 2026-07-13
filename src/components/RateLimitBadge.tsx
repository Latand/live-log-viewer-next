"use client";

import { Badge } from "@/components/ui/Badge";
import { useLocale } from "@/lib/i18n";
import type { RateLimitState } from "@/lib/types";

import { rateLimitText } from "./rateLimit";

export function RateLimitBadge({ rateLimit }: { rateLimit?: RateLimitState | null }) {
  const { locale, t } = useLocale();
  if (!rateLimit) return null;
  const label = rateLimitText(t, locale, rateLimit);
  return (
    <Badge tone="danger" dataAttr="data-rate-limited" title={label}>
      {label}
    </Badge>
  );
}
