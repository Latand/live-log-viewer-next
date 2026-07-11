import { expect, test } from "bun:test";

import { filesApiUrl, filesPollCadence, filesRequestHeaders } from "./useFiles";

test("filesApiUrl requests selected project hydration", () => {
  expect(filesApiUrl()).toBe("/api/files");
  expect(filesApiUrl(null)).toBe("/api/files");
  expect(filesApiUrl("stikon-dispatcher")).toBe("/api/files?project=stikon-dispatcher");
  expect(filesApiUrl("space project")).toBe("/api/files?project=space%20project");
});

test("files revision reads identify the revision and retain ETag revalidation", () => {
  expect(filesRequestHeaders("", undefined)).toBeUndefined();
  expect(filesRequestHeaders('"cached"', 42)).toEqual({
    "If-None-Match": '"cached"',
    "x-llv-files-revision": "42",
  });
});

test("a healthy live stream disables the recurring files poll; every other state restores it", () => {
  expect(filesPollCadence("live")).toBe("live");
  expect(filesPollCadence("reconnecting")).toBe("poll");
  expect(filesPollCadence("degraded")).toBe("poll");
  expect(filesPollCadence("offline")).toBe("poll");
});
