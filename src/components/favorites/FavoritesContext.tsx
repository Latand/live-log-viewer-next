"use client";

import { createContext, useContext } from "react";

/** Per-project crown favorites, exposed to any conversation card without
    threading board state through the scheme/node layers (issue #185). Backed by
    the durable board prefs in `ProjectDashboard`; ids are `conversationIdentity`
    values so a favorite survives a resume that changes the transcript path. */
export interface FavoritesApi {
  has(id: string): boolean;
  toggle(id: string): void;
}

const FavoritesContext = createContext<FavoritesApi | null>(null);

export const FavoritesProvider = FavoritesContext.Provider;

/** The favorites API for the enclosing project, or null outside a provider
    (e.g. a BranchPane rendered in a context with no board). */
export function useFavorites(): FavoritesApi | null {
  return useContext(FavoritesContext);
}
