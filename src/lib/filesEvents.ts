export const FILES_CHANGED_EVENT = "llv:files-changed";

export function requestFilesRefresh(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
}
