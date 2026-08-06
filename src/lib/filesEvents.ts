export const FILES_CHANGED_EVENT = "llv:files-changed";
export const FILES_REVALIDATION_STARTED_EVENT = "llv:files-revalidation-started";
export const FILES_REVALIDATED_EVENT = "llv:files-revalidated";

export interface FilesRevalidationStartedDetail {
  requestId: number;
}

export interface FilesRevalidatedDetail {
  requestId: number;
  crownedProjects: readonly string[];
}

export function requestFilesRefresh(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
}

export function publishFilesRevalidationStarted(requestId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new window.CustomEvent<FilesRevalidationStartedDetail>(FILES_REVALIDATION_STARTED_EVENT, {
    detail: { requestId },
  }));
}

export function publishFilesRevalidated(requestId: number, crownedProjects: readonly string[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new window.CustomEvent<FilesRevalidatedDetail>(FILES_REVALIDATED_EVENT, {
    detail: { requestId, crownedProjects },
  }));
}
