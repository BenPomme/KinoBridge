import { describe, expect, it } from "vitest";
import { StreamDescriptorSchema } from "@kinobridge/shared";
import { isFreshRefreshDescriptor, parseRefreshBinding } from "../src/refresh.js";

function descriptor(overrides: Record<string, unknown> = {}) {
  return StreamDescriptorSchema.parse({
    source: "kino.pub",
    candidate: {
      id: "fresh", tabId: 4, navigationId: "nav", requestId: "request",
      url: "https://cdn.example/fresh.m3u8", pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1",
      pageTitle: "Fixture", observedAt: 200, access: { headers: [] },
      ...((overrides.candidate as Record<string, unknown> | undefined) ?? {})
    },
    classification: "master",
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "candidate"))
  });
}

describe("refresh candidate freshness", () => {
  const requirement = {
    tabId: 4,
    navigationId: "nav",
    pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1",
    pageTitle: "Fixture",
    rootRole: "master" as const,
    expiredCandidateId: "expired",
    minimumObservedAt: 150
  };

  it("accepts only a newly observed candidate bound to the original tab, navigation, page, title, and role", () => {
    expect(isFreshRefreshDescriptor(descriptor(), requirement)).toBe(true);
    expect(isFreshRefreshDescriptor(descriptor({ candidate: { id: "expired" } }), requirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ candidate: { observedAt: 149 } }), requirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ candidate: { tabId: 5 } }), requirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ candidate: { navigationId: "other-nav" } }), requirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ candidate: { pageUrl: "https://zerkalo.xyz/item/view/99999/s0e1" } }), requirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ candidate: { pageTitle: "Another Movie" } }), requirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ classification: "video" }), requirement)).toBe(false);
  });

  it("does not substitute a master playlist when the expired root was a video playlist", () => {
    const videoRequirement = { ...requirement, rootRole: "video" as const };
    expect(isFreshRefreshDescriptor(descriptor({ classification: "master" }), videoRequirement)).toBe(false);
    expect(isFreshRefreshDescriptor(descriptor({ classification: "video" }), videoRequirement)).toBe(true);
  });

  it("rejects incomplete native refresh bindings", () => {
    expect(parseRefreshBinding(requirement)).toEqual(expect.objectContaining({ rootRole: "master", navigationId: "nav" }));
    expect(parseRefreshBinding({ ...requirement, pageUrl: "not-a-url" })).toBeUndefined();
    expect(parseRefreshBinding({ ...requirement, rootRole: "subtitle" })).toBeUndefined();
    expect(parseRefreshBinding({ ...requirement, pageTitle: "" })).toBeUndefined();
  });
});
