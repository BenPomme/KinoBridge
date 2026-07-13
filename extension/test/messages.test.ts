import { describe, expect, it } from "vitest";
import { isPopupRequest } from "../src/messages.js";

describe("companion message validation", () => {
  it("requires a finite non-negative source tab for tab-bound commands", () => {
    for (const type of ["prepareStream", "addOverride", "run", "offlineRetry"]) {
      expect(isPopupRequest({ type })).toBe(false);
      expect(isPopupRequest({ type, sourceTabId: -1 })).toBe(false);
      expect(isPopupRequest({ type, sourceTabId: 1.5 })).toBe(false);
      expect(isPopupRequest({ type, sourceTabId: 42 })).toBe(true);
    }
  });

  it("continues to accept source-independent requests", () => {
    expect(isPopupRequest({ type: "getState" })).toBe(true);
    expect(isPopupRequest({ type: "cancel", jobId: "job" })).toBe(true);
    expect(isPopupRequest({ type: "unknown" })).toBe(false);
  });
});
