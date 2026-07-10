"use client";

import {
  type AccountLoadState,
  accountEntryPointVisible,
  accountNoticeText,
  type AccountNotice,
  type AccountOperation,
  type AccountOption,
  type AccountSwitchView,
  accountSwitchView,
  createEngineAccountsStore,
  type DeviceAuth,
  type EngineAccountsStoreOptions,
  type ManagedAttemptState,
  pendingDeviceAuth,
  useEngineAccounts,
} from "./useEngineAccounts";

/**
 * Codex-scoped compatibility shim over the engine-parameterized account store
 * (see {@link useEngineAccounts}). Kept so the Switchboard's compact selector,
 * the legacy Codex panel, and their tests keep working unchanged while the
 * unified {@link AccountsPanel} moves to `useEngineAccounts` directly. Both this
 * hook and `useEngineAccounts("codex")` share the one codex singleton, so the
 * footer, Switchboard, and panel never diverge.
 */

export type { AccountLoadState, AccountNotice, AccountOperation, AccountSwitchView, DeviceAuth, ManagedAttemptState };
export type CodexAccountOption = AccountOption;
export { accountNoticeText, accountSwitchView, pendingDeviceAuth };
export const codexEntryPointVisible = accountEntryPointVisible;
export type CodexAccountsStoreOptions = EngineAccountsStoreOptions;

/** Legacy narrow snapshot — the subset the Codex panel/switch consume. The
    generalized store returns a superset (adds `migration`/`autoBalance`), which
    remains assignable to this shape. */
export interface CodexAccountsSnapshot {
  accounts: CodexAccountOption[];
  active: string;
  identityVersion: number;
  status: AccountLoadState;
  notice: AccountNotice | null;
  challenge: DeviceAuth | null;
  mutation: AccountOperation | null;
}

export interface CodexAccountsState extends CodexAccountsSnapshot {
  refresh: () => Promise<boolean>;
  select: (id: string) => Promise<boolean>;
  add: (label: string) => Promise<boolean>;
  retryNotice: () => Promise<boolean>;
}

export const createCodexAccountsStore = (options: CodexAccountsStoreOptions = {}) => createEngineAccountsStore("codex", options);

export function useCodexAccounts(): CodexAccountsState {
  return useEngineAccounts("codex");
}
