"use client";

import { createContext, useContext } from "react";

/** Presentation belongs to the surface; it never changes the shared feed data. */
export const ToolDisclosurePolicy = createContext<"board" | "collapsed">("board");
export const useCollapsedTools = () => useContext(ToolDisclosurePolicy) === "collapsed";
