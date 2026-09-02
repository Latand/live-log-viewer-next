"use client";

import type { ReactNode } from "react";

import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";
import type { MobileSheetName } from "./mobileNav";

/*
 * The board menu (docs/design/mobile-v2/README.md §3.1, §4.1): the ⋯ on every
 * screen opens it over that screen. Its rows are the board's actions as
 * labelled 44 px rows — create actions first, then the places (Tasks, All
 * conversations, Accounts & limits, Host details), then the device-local
 * settings, then Archive project last. No row asks for confirmation; the
 * receipt carries the inverse. The owner (the project board, the overview)
 * decides the rows; this component only lays them out.
 */

export type MobileMenuEntry =
  | {
      kind: "row";
      key: string;
      icon?: ReactNode;
      label: string;
      trailing?: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      /** A radio row (the board's two faces) announces the one shown. */
      checked?: boolean;
      danger?: boolean;
      /** Harness hook: the screen this row pushes (`data-mobile2-go`). */
      go?: string;
      /** Harness hook: the sheet this row opens (`data-mobile2-open`). */
      opens?: MobileSheetName;
      testId?: string;
    }
  | { kind: "divider"; key: string }
  /** An existing control rendered as a row (the sound cluster, keep awake). */
  | { kind: "custom"; key: string; node: ReactNode };

export function MobileMenuSheet({ title, entries, onClose }: { title: string; entries: MobileMenuEntry[]; onClose: () => void }) {
  return (
    <MobileSheet name="menu" title={title} onClose={onClose}>
      <div role="menu" aria-label={title} className="flex flex-col">
        {entries.map((entry) => {
          if (entry.kind === "divider") return <MobileSheetDivider key={entry.key} />;
          if (entry.kind === "custom") return <div key={entry.key}>{entry.node}</div>;
          return (
            <MobileSheetRow
              key={entry.key}
              icon={entry.icon}
              label={entry.label}
              trailing={entry.trailing}
              onSelect={entry.onSelect}
              disabled={entry.disabled}
              checked={entry.checked}
              danger={entry.danger}
              role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
              testId={entry.testId}
              attrs={{ "data-mobile2-go": entry.go, "data-mobile2-open": entry.opens, "data-mobile2-menu-row": entry.key }}
            />
          );
        })}
      </div>
    </MobileSheet>
  );
}
