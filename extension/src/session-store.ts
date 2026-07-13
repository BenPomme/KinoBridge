import {
  StreamCandidateSchema,
  StreamDescriptorSchema,
  type StreamCandidate,
  type StreamDescriptor
} from "@kinobridge/shared";
import { sortCandidates } from "./candidates.js";

const MAX_CANDIDATES_PER_TAB = 50;
const candidateKey = (tabId: number): string => `candidates:${tabId}`;
const navigationKey = (tabId: number): string => `navigation:${tabId}`;
const descriptorKey = (tabId: number): string => `descriptors:${tabId}`;
const writeQueues = new Map<number, Promise<void>>();
const descriptorQueues = new Map<number, Promise<void>>();

export interface NavigationState {
  id: string;
  pageUrl: string;
  startedAt: number;
}

export async function initializeSessionStorage(): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function getNavigation(tabId: number): Promise<NavigationState | undefined> {
  const value = (await chrome.storage.session.get(navigationKey(tabId)))[navigationKey(tabId)];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<NavigationState>;
  if (typeof candidate.id !== "string" || typeof candidate.pageUrl !== "string" || typeof candidate.startedAt !== "number") {
    return undefined;
  }
  return candidate as NavigationState;
}

export async function ensureNavigation(tabId: number, pageUrl: string, forceNew = false): Promise<NavigationState> {
  const current = await getNavigation(tabId);
  if (!forceNew && current?.pageUrl === pageUrl) return current;
  const next: NavigationState = { id: crypto.randomUUID(), pageUrl, startedAt: Date.now() };
  await chrome.storage.session.set({
    [navigationKey(tabId)]: next,
    [candidateKey(tabId)]: [],
    [descriptorKey(tabId)]: {}
  });
  return next;
}

export async function getCandidates(tabId: number): Promise<StreamCandidate[]> {
  const value = (await chrome.storage.session.get(candidateKey(tabId)))[candidateKey(tabId)];
  if (!Array.isArray(value)) return [];
  return sortCandidates(value.flatMap((item) => {
    const parsed = StreamCandidateSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }));
}

export async function upsertCandidate(candidate: StreamCandidate): Promise<StreamCandidate> {
  const parsed = StreamCandidateSchema.parse(candidate);
  const previous = writeQueues.get(parsed.tabId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const candidates = await getCandidates(parsed.tabId);
    const existing = candidates.find((item) => item.id === parsed.id);
    const merged = existing
      ? {
          ...existing,
          ...parsed,
          access: {
            ...existing.access,
            ...parsed.access,
            headers: parsed.access.headers.length > 0 ? parsed.access.headers : existing.access.headers
          }
        }
      : parsed;
    const next = sortCandidates([merged, ...candidates.filter((item) => item.id !== merged.id)])
      .slice(0, MAX_CANDIDATES_PER_TAB);
    await chrome.storage.session.set({ [candidateKey(parsed.tabId)]: next });
    return merged;
  });
  writeQueues.set(parsed.tabId, operation.then(() => undefined, () => undefined));
  return operation;
}

export async function setDescriptor(descriptor: StreamDescriptor): Promise<void> {
  const parsed = StreamDescriptorSchema.parse(descriptor);
  const tabId = parsed.candidate.tabId;
  const previous = descriptorQueues.get(tabId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const key = descriptorKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key];
    const descriptors = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
    await chrome.storage.session.set({ [key]: { ...descriptors, [parsed.candidate.id]: parsed } });
  });
  descriptorQueues.set(tabId, operation.then(() => undefined, () => undefined));
  await operation;
}

export async function getDescriptor(tabId: number, candidateId: string): Promise<StreamDescriptor | undefined> {
  await (descriptorQueues.get(tabId) ?? Promise.resolve());
  const key = descriptorKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored || typeof stored !== "object") return undefined;
  const parsed = StreamDescriptorSchema.safeParse((stored as Record<string, unknown>)[candidateId]);
  return parsed.success ? parsed.data : undefined;
}

export async function removeTabState(tabId: number): Promise<void> {
  await (writeQueues.get(tabId) ?? Promise.resolve());
  await (descriptorQueues.get(tabId) ?? Promise.resolve());
  writeQueues.delete(tabId);
  descriptorQueues.delete(tabId);
  await chrome.storage.session.remove([candidateKey(tabId), navigationKey(tabId), descriptorKey(tabId)]);
}
