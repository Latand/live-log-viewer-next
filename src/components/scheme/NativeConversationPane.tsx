"use client";

import { Component, memo, useCallback, useLayoutEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { BranchPane } from "@/components/BranchPane";
import { TmuxComposer } from "@/components/TmuxComposer";
import { DormantView } from "@/components/conversation/DormantView";

type Props = ComponentProps<typeof BranchPane> & {
  active: boolean;
  place: HTMLElement | null;
  fullWindowPlace: HTMLElement | null;
};

/** A portal's target never changes. Moving that target preserves the actual
 * reader, textarea and selection through a full-window round trip. */
export const NativeConversationPane = memo(function NativeConversationPane({
  active, place, fullWindowPlace, ...pane
}: Props) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [composerDock, setComposerDock] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = document.createElement("div");
    element.className = "flex min-h-0 min-w-0 flex-1";
    const dock = document.createElement("div");
    dock.className = "contents";
    setContainer(element);
    setComposerDock(dock);
    return () => { element.remove(); };
  }, []);
  useLayoutEffect(() => {
    if (!container) return;
    container.dataset.nativeOwner = pane.file.conversationId ?? pane.file.path;
    container.dataset.nativePath = pane.file.path;
  }, [container, pane.file.conversationId, pane.file.path]);
  const attachComposer = useCallback((node: HTMLDivElement | null) => {
    if (node && composerDock && composerDock.parentNode !== node) node.append(composerDock);
  }, [composerDock]);
  if (!container || !composerDock) return null;
  return <NativePlacement active={active} container={container} place={place} fullWindowPlace={fullWindowPlace}>{createPortal(<>
    <DormantView active={active}>
      <BranchPane {...pane} noComposer composerMount={attachComposer} />
    </DormantView>
    {createPortal(<TmuxComposer file={pane.file} pollPaused={!active} viewActive={active} />, composerDock)}
  </>, container)}</NativePlacement>;
}, (before, after) => !before.active && !after.active && before.place === after.place && before.fullWindowPlace === after.fullWindowPlace);


function captureReader(container: HTMLElement) {
  const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
  const selection = document.getSelection();
  const range = selection?.rangeCount && container.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
  const scrolls = [...container.querySelectorAll<HTMLElement>("[data-log-feed-scroller]")].map(element => {
    const frame = element.getBoundingClientRect(), scale = frame.height / element.clientHeight || 1;
    const row = [...element.querySelectorAll<HTMLElement>("[data-feed-key]")].find(row => row.getBoundingClientRect().bottom > frame.top);
    return {
      element, top: element.scrollTop, row, offset: row ? (row.getBoundingClientRect().top - frame.top) / scale : 0,
      followed: element.scrollHeight - element.scrollTop - element.clientHeight < 2
    };
  });
  const fields = [...container.querySelectorAll<HTMLTextAreaElement>("textarea, input[type=text]")].map(element => ({ element, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection }));
  return { focused, range, scrolls, fields };
}

type PlacementProps = { active: boolean; container: HTMLElement; place: HTMLElement | null; fullWindowPlace: HTMLElement | null; children: React.ReactNode };
/** Capture before React hides/removes the old destination. A layout effect is
 * too late to measure a reader whose former ancestor already left the DOM. */
class NativePlacement extends Component<PlacementProps> {
  private retained: ReturnType<typeof captureReader> | null = null;
  getSnapshotBeforeUpdate() {
    const snapshot=captureReader(this.props.container);
    if(snapshot.scrolls.some(({element})=>element.getBoundingClientRect().height>0))this.retained=snapshot;
    return this.retained??snapshot;
  }
  componentDidMount() { this.place(null); }
  componentDidUpdate(previous: PlacementProps, _state: unknown, snapshot: ReturnType<typeof captureReader>) { this.place(snapshot, this.props.active && !previous.active); }
  place(snapshot: ReturnType<typeof captureReader> | null, restore = false) {
    const { container, place, fullWindowPlace } = this.props;
    const destination = fullWindowPlace ?? place;
    if (!destination || (container.parentNode === destination && !restore)) return;
    destination.append(container);
    if (!snapshot) return;
    snapshot.focused?.focus({ preventScroll: true });
    const selection = document.getSelection();
    if (snapshot.range && selection) { selection.removeAllRanges(); selection.addRange(snapshot.range); }
    for (const { element, start, end, direction } of snapshot.fields) element.setSelectionRange(start, end, direction ?? undefined);
    for (const { element, top, row, offset, followed } of snapshot.scrolls) {
      if (followed) { element.scrollTop = element.scrollHeight; continue; }
      element.scrollTop = top;
      if (row) { const frame = element.getBoundingClientRect(), scale = frame.height / element.clientHeight || 1; element.scrollTop += (row.getBoundingClientRect().top - frame.top) / scale - offset; }
    }
  }
  render() { return this.props.children; }
}
