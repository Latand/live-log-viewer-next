"use client";

import { Activity, memo, useRef, type ReactNode } from "react";

/** Retain a warmed view's state without sending new props into React's hidden
 * pre-render lane. Activity disconnects the view's subscriptions and effects;
 * delivery controllers must be siblings of this boundary. */
export const DormantView = memo(function DormantView({ active, children }: {
  active: boolean;
  children: ReactNode;
}) {
  const retained = useRef<ReactNode>(null);
  if (active) retained.current = children;
  return <Activity mode={active ? "visible" : "hidden"}>{retained.current}</Activity>;
}, (before, after) => !before.active && !after.active);
