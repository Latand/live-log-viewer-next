"use client";

import { useEffect, useRef, type RefObject } from "react";

/*
 * A process-wide stack of open modal layers so nested modals coordinate
 * ownership (#507 final review F2). A phone opens a bottom sheet
 * (`MobileSheet`) and then a stage editor ABOVE it; both are dialogs
 * that trap Tab focus and answer Escape on `window`. Without coordination the
 * lower sheet's trap yanks Tab back out of the editor and its Escape closes the
 * wrong surface. This stack makes exactly the TOPMOST layer own Tab and Escape;
 * every layer beneath yields until it becomes top again.
 *
 * The stack is a pure list of opaque ids pushed on open and popped on unmount —
 * no React context, so a body-portaled editor (rendered outside the sheet's
 * subtree) still coordinates with it.
 */
let layers: symbol[] = [];

function pushLayer(): symbol {
  const id = Symbol("modal-layer");
  layers.push(id);
  return id;
}

function popLayer(id: symbol): void {
  layers = layers.filter((entry) => entry !== id);
}

/** Is this layer the one that currently owns Tab/Escape (top of the stack)? */
export function isTopModalLayer(id: symbol): boolean {
  return layers.length > 0 && layers[layers.length - 1] === id;
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Is this element in the browser's Tab order at all?
 *
 * The selector's `:not([tabindex="-1"])` guard only qualifies the `[tabindex]`
 * clause — `button`, `input` and friends match even when explicitly untabbable.
 * That matters for a combobox whose `role="option"` rows are driven by
 * `aria-activedescendant` and therefore carry `tabIndex={-1}` (issue #1054): as
 * raw matches they became the trap's `last` boundary, so Tab from the last
 * genuinely tabbable control compared against an element the browser skips,
 * declined to wrap, and let focus walk straight out of the open dialog.
 *
 * Read from the attribute rather than the `tabIndex` property so the answer
 * does not depend on a DOM implementation's default for each tag.
 */
function isTabbable(el: HTMLElement): boolean {
  const tabindex = el.getAttribute("tabindex");
  if (tabindex === null) return true;
  const parsed = Number.parseInt(tabindex, 10);
  /* An unparseable value leaves the element's default behaviour intact. */
  return Number.isNaN(parsed) || parsed >= 0;
}

export interface ModalLayerOptions {
  /** The dialog container: Tab is trapped within it and (when `manageFocus`)
      focus lands here on open. */
  containerRef: RefObject<HTMLElement | null>;
  /** Dismiss the layer — invoked on Escape while this layer is on top. */
  onClose: () => void;
  /** Lock body scroll while open, like a bottom sheet. Anchored popovers over an
      already-locked sheet pass false. Default true. */
  lockScroll?: boolean;
  /** Move focus into the container on open and back to the opener on close.
      A caller that already restores focus to its own trigger passes false and
      keeps its own focus-in (e.g. an `autoFocus` control). Default true. */
  manageFocus?: boolean;
}

/**
 * Registers an open dialog as a modal layer: pushes it on the ownership stack,
 * traps Tab/Shift+Tab within its container and answers Escape — but ONLY while
 * it is the topmost layer, so a lower sheet yields to a stage editor above it
 * and reclaims ownership when the editor closes. Optionally locks body scroll
 * and moves focus in on open / back to the opener on close.
 *
 * Mount-only for the push/scroll/focus lifecycle so a parent poll re-render
 * never re-runs it and yanks focus; the key listener rebinds on `onClose`
 * identity but no-ops unless this layer is on top.
 */
export function useModalLayer({ containerRef, onClose, lockScroll = true, manageFocus = true }: ModalLayerOptions): void {
  const idRef = useRef<symbol | null>(null);

  useEffect(() => {
    const id = pushLayer();
    idRef.current = id;
    const opener = manageFocus && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (manageFocus) containerRef.current?.focus();
    const previousOverflow = lockScroll ? document.body.style.overflow : null;
    if (lockScroll) document.body.style.overflow = "hidden";
    return () => {
      popLayer(id);
      idRef.current = null;
      if (lockScroll && previousOverflow !== null) document.body.style.overflow = previousOverflow;
      if (manageFocus && opener?.isConnected) opener.focus();
    };
    // Mount-only: capturing the opener and locking scroll must happen once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = idRef.current;
      if (!id || !isTopModalLayer(id)) return;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (el) => !el.hasAttribute("disabled") && isTabbable(el),
      );
      if (!focusables.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && container.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first || active === container) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, containerRef]);
}
