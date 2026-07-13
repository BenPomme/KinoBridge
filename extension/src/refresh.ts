import type { StreamDescriptor } from "@kinobridge/shared";

export type RefreshRootRole = "master" | "video";

export interface RefreshBinding {
  tabId: number;
  navigationId: string;
  pageUrl: string;
  pageTitle: string;
  rootRole: RefreshRootRole;
}

export interface RefreshRequirement extends RefreshBinding {
  expiredCandidateId: string;
  minimumObservedAt: number;
}

function normalizedTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function samePage(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export function parseRefreshBinding(raw: unknown): RefreshBinding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (!Number.isInteger(value.tabId) || (value.tabId as number) < 0
    || typeof value.navigationId !== "string" || value.navigationId.length === 0
    || typeof value.pageUrl !== "string" || !samePage(value.pageUrl, value.pageUrl)
    || typeof value.pageTitle !== "string" || value.pageTitle.length === 0
    || (value.rootRole !== "master" && value.rootRole !== "video")) return undefined;
  return {
    tabId: value.tabId as number,
    navigationId: value.navigationId,
    pageUrl: value.pageUrl,
    pageTitle: value.pageTitle,
    rootRole: value.rootRole
  };
}

export function isFreshRefreshDescriptor(descriptor: StreamDescriptor, requirement: RefreshRequirement): boolean {
  const candidate = descriptor.candidate;
  return candidate.tabId === requirement.tabId
    && candidate.id !== requirement.expiredCandidateId
    && candidate.observedAt >= requirement.minimumObservedAt
    && candidate.navigationId === requirement.navigationId
    && samePage(candidate.pageUrl, requirement.pageUrl)
    && normalizedTitle(candidate.pageTitle) === normalizedTitle(requirement.pageTitle)
    && descriptor.classification === requirement.rootRole;
}
