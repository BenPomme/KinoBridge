import {
  AccessContextSchema,
  DownloadOptionsSchema,
  EnvelopeSchema,
  OfflineSnapshotSchema,
  PlaybackOptionsSchema,
  StreamCandidateSchema,
  StreamDescriptorSchema,
  makeEnvelope,
  minimalAccessContext,
  type AccessContext,
  type Envelope,
  type OfflineSnapshot,
  type StreamDescriptor
} from "@kinobridge/shared";
import { candidatePreview, classifyPlaylistUrl, isAllowedManualOverride, isHlsPlaylistUrl, isKinoPageUrl, rankClassification } from "./candidates.js";
import { isPopupRequest, type PopupRequest, type PopupResponse, type PopupState } from "./messages.js";
import { isFreshRefreshDescriptor, parseRefreshBinding, type RefreshRequirement } from "./refresh.js";
import {
  ensureNavigation,
  getCandidates,
  getDescriptor,
  getNavigation,
  initializeSessionStorage,
  removeTabState,
  setDescriptor,
  upsertCandidate
} from "./session-store.js";

const NATIVE_HOST = "com.kinobridge.helper";
const STATUS_KEY = "native-status";
const ACTIVE_JOB_KEY = "active-job-id";
const OFFLINE_STATE_KEY = "offline-state";
const MAX_STATUS_LENGTH = 300;
let nativePort: chrome.runtime.Port | undefined;
let reconnectDelayMs = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const pendingNativeRequests = new Map<string, { resolve: (payload: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const pendingRefreshJobs = new Map<string, RefreshRequirement & { timer: ReturnType<typeof setTimeout> }>();

function safeError(error: unknown): string {
  return error instanceof Error ? redactText(error.message) : "Unexpected extension error";
}

function redactText(input: string): string {
  return input
    .replace(/https:\/\/[^\s]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.search = url.search ? "?[REDACTED]" : "";
        return url.toString();
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/\b(cookie|authorization|token|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, MAX_STATUS_LENGTH);
}

async function setStatus(message: string): Promise<void> {
  const status = redactText(message);
  await chrome.storage.session.set({ [STATUS_KEY]: status });
  void chrome.runtime.sendMessage({ type: "statusChanged", status }).catch(() => undefined);
}

async function getStatus(): Promise<string> {
  const value = (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY];
  return typeof value === "string" ? value : "Native helper is connecting…";
}

function connectNative(): void {
  if (nativePort) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    reconnectDelayMs = 1_000;
    void setStatus("Native helper connected");
    port.onMessage.addListener((message: unknown) => void handleNativeMessage(message));
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message;
      nativePort = undefined;
      void setStatus(detail ? `Native helper unavailable: ${detail}` : "Native helper disconnected");
      scheduleReconnect();
    });
    port.postMessage(makeEnvelope("hello", { extensionVersion: chrome.runtime.getManifest().version }));
  } catch (error) {
    nativePort = undefined;
    void setStatus(`Native helper unavailable: ${safeError(error)}`);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectNative();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
}

function postNative(envelope: Envelope): void {
  if (!nativePort) {
    connectNative();
    throw new Error("Native helper is not connected");
  }
  nativePort.postMessage(envelope);
}

function requestNative(type: Envelope["type"], payload: unknown, timeoutMs = 10_000): Promise<unknown> {
  const envelope = makeEnvelope(type, payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeRequests.delete(envelope.id);
      reject(new Error("Native helper did not respond in time"));
    }, timeoutMs);
    pendingNativeRequests.set(envelope.id, { resolve, reject, timer });
    try {
      postNative(envelope);
    } catch (error) {
      clearTimeout(timer);
      pendingNativeRequests.delete(envelope.id);
      reject(error instanceof Error ? error : new Error("Native helper request failed"));
    }
  });
}

async function setOfflineState(raw: unknown): Promise<OfflineSnapshot | undefined> {
  const parsed = OfflineSnapshotSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  await chrome.storage.local.set({ [OFFLINE_STATE_KEY]: parsed.data });
  void chrome.runtime.sendMessage({ type: "offlineChanged" }).catch(() => undefined);
  return parsed.data;
}

async function getOfflineState(): Promise<OfflineSnapshot> {
  const raw = (await chrome.storage.local.get(OFFLINE_STATE_KEY))[OFFLINE_STATE_KEY];
  const parsed = OfflineSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : { queue: [], library: [] };
}

async function handleNativeMessage(message: unknown): Promise<void> {
  const parsed = EnvelopeSchema.safeParse(message);
  if (!parsed.success) {
    await setStatus("Native helper sent an invalid protocol message");
    return;
  }
  const envelope = parsed.data;
  const pending = pendingNativeRequests.get(envelope.id);
  if (pending && (envelope.type === "offlineState" || envelope.type === "failed")) {
    clearTimeout(pending.timer);
    pendingNativeRequests.delete(envelope.id);
    if (envelope.type === "failed") {
      const payload = envelope.payload as { error?: { message?: unknown } };
      pending.reject(new Error(typeof payload.error?.message === "string" ? payload.error.message : "Native helper request failed"));
    } else pending.resolve(envelope.payload);
  }
  switch (envelope.type) {
    case "ready": {
      const payload = envelope.payload as { offline?: unknown };
      if (payload.offline) await setOfflineState(payload.offline);
      await setStatus("Native helper ready");
      break;
    }
    case "probeResult": {
      const payload = envelope.payload as { descriptor?: unknown };
      const descriptor = StreamDescriptorSchema.safeParse(payload?.descriptor);
      if (!descriptor.success) {
        await setStatus("Native helper returned invalid stream metadata");
        break;
      }
      await setDescriptor(descriptor.data);
      await fulfillPendingRefresh(descriptor.data);
      await setStatus("Stream inspected and ready");
      break;
    }
    case "progress": {
      const payload = envelope.payload as { percent?: unknown; job?: { progress?: { percent?: unknown } }; offline?: unknown };
      if (payload.offline) await setOfflineState(payload.offline);
      const rawPercent = typeof payload?.percent === "number" ? payload.percent : payload?.job?.progress?.percent;
      const percent = typeof rawPercent === "number" ? Math.max(0, Math.min(100, rawPercent)) : undefined;
      await setStatus(percent === undefined ? "Media job in progress" : `Media job ${Math.round(percent)}%`);
      break;
    }
    case "completed": {
      const payload = envelope.payload as { offline?: unknown };
      if (payload.offline) await setOfflineState(payload.offline);
      await chrome.storage.session.remove(ACTIVE_JOB_KEY);
      await setStatus("Media job completed");
      break;
    }
    case "failed": {
      await chrome.storage.session.remove(ACTIVE_JOB_KEY);
      const payload = envelope.payload as { error?: { message?: unknown }; offline?: unknown };
      if (payload.offline) await setOfflineState(payload.offline);
      await setStatus(typeof payload?.error?.message === "string" ? `Media job failed: ${payload.error.message}` : "Media job failed");
      break;
    }
    case "offlineState":
      await setOfflineState(envelope.payload);
      break;
    case "refreshRequired":
      await refreshNativeCandidate(envelope.payload);
      break;
    default:
      break;
  }
}

async function refreshNativeCandidate(rawPayload: unknown): Promise<void> {
  const payload = rawPayload as { jobId?: unknown; candidateId?: unknown };
  const binding = parseRefreshBinding(rawPayload);
  if (typeof payload?.jobId !== "string" || typeof payload.candidateId !== "string" || !binding) {
    await setStatus("Native helper sent an invalid or unbound refresh request");
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(binding.tabId);
  } catch {
    await setStatus("Refresh requested: reopen the original Kino title tab and start playback");
    return;
  }
  const navigation = await getNavigation(binding.tabId);
  if (!isKinoPageUrl(tab.url) || !sameKinoPage(binding.pageUrl, tab.url as string) || navigation?.id !== binding.navigationId) {
    await setStatus("Refresh requested: return to the original Kino title tab and start playback without navigating away");
    return;
  }
  const candidates = await getCandidates(binding.tabId);
  const expiredCandidateId = payload.candidateId;
  const expired = candidates.find((candidate) => candidate.id === expiredCandidateId);
  const requirement: RefreshRequirement = {
    ...binding,
    expiredCandidateId,
    minimumObservedAt: expired?.observedAt === undefined ? Date.now() - 1_000 : expired.observedAt + 1
  };
  for (const candidate of candidates) {
    if (candidate.id === expiredCandidateId || (expired && candidate.observedAt <= expired.observedAt)) continue;
    const descriptor = await getDescriptor(binding.tabId, candidate.id);
    if (!descriptor || !isFreshRefreshDescriptor(descriptor, requirement)) continue;
    postNative(makeEnvelope("refreshResponse", { jobId: payload.jobId, candidate }));
    await setStatus("Offline stream access refreshed");
    return;
  }
  const previous = pendingRefreshJobs.get(payload.jobId);
  if (previous) clearTimeout(previous.timer);
  // Keep the browser-side candidate waiter alive for the broker's 60-second
  // refresh window, while leaving a small margin for message delivery.
  const timer = setTimeout(() => pendingRefreshJobs.delete(payload.jobId as string), 59_000);
  pendingRefreshJobs.set(payload.jobId, { ...requirement, timer });
  await setStatus("Stream access expired: press Play in the original Kino tab for a few seconds to refresh the download");
}

async function fulfillPendingRefresh(descriptor: StreamDescriptor): Promise<void> {
  for (const [jobId, pending] of pendingRefreshJobs) {
    if (!isFreshRefreshDescriptor(descriptor, pending)) continue;
    const candidate = descriptor.candidate;
    clearTimeout(pending.timer);
    pendingRefreshJobs.delete(jobId);
    postNative(makeEnvelope("refreshResponse", { jobId, candidate }));
    await setStatus("Offline stream access refreshed; download retrying…");
  }
}

function requestAccess(details: chrome.webRequest.OnBeforeSendHeadersDetails): AccessContext {
  const headers = details.requestHeaders ?? [];
  const first = (name: string): string | undefined =>
    headers.find((header: chrome.webRequest.HttpHeader) => header.name.toLowerCase() === name)?.value;
  return AccessContextSchema.parse({
    ...(first("referer") ? { referer: first("referer") } : {}),
    ...(first("user-agent") ? { userAgent: first("user-agent") } : {}),
    ...(first("cookie") ? { cookie: first("cookie") } : {}),
    headers: []
  });
}

async function observePlaylist(
  details: Pick<chrome.webRequest.WebRequestDetails, "requestId" | "tabId" | "url" | "initiator">,
  access?: AccessContext
): Promise<void> {
  if (details.tabId < 0 || !isHlsPlaylistUrl(details.url)) return;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(details.tabId);
  } catch {
    return;
  }
  if (!isKinoPageUrl(tab.url)) return;
  const pageUrl = tab.url as string;
  const navigation = await ensureNavigation(details.tabId, pageUrl);
  const id = `${details.tabId}:${navigation.id}:${details.requestId}`;
  const candidate = StreamCandidateSchema.parse({
    id,
    tabId: details.tabId,
    navigationId: navigation.id,
    requestId: details.requestId,
    url: details.url,
    ...(details.initiator ? { initiator: details.initiator } : {}),
    pageUrl,
    pageTitle: tab.title ?? "Kino.pub stream",
    observedAt: Date.now(),
    access: minimalAccessContext(access ?? { headers: [] })
  });
  const merged = await upsertCandidate(candidate);
  void chrome.runtime.sendMessage({ type: "candidatesChanged", tabId: details.tabId }).catch(() => undefined);
  if (access) {
    try {
      postNative(makeEnvelope("probe", { candidate: merged }));
      await setStatus("Inspecting detected stream…");
    } catch (error) {
      await setStatus(safeError(error));
    }
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => void observePlaylist(details),
  { urls: ["https://*/*"], types: ["xmlhttprequest", "media", "other"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isHlsPlaylistUrl(details.url)) return;
    void observePlaylist(details, requestAccess(details));
  },
  { urls: ["https://*/*"], types: ["xmlhttprequest", "media", "other"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" && !changeInfo.url) return;
  if (isKinoPageUrl(tab.url)) {
    void ensureNavigation(tabId, tab.url as string, true);
  } else {
    void removeTabState(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void removeTabState(tabId));

async function popupState(): Promise<PopupState> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !isKinoPageUrl(tab.url)) {
    const activeJobId = (await chrome.storage.session.get(ACTIVE_JOB_KEY))[ACTIVE_JOB_KEY];
    return {
      isKinoTab: false,
      title: "Open a Kino.pub title to begin",
      candidates: [],
      nativeStatus: await getStatus(),
      cdnAccessGranted: await chrome.permissions.contains({ origins: ["https://*/*"] }),
      ...(typeof activeJobId === "string" ? { activeJobId } : {}),
      offline: await getOfflineState()
    };
  }
  const [candidates, navigation] = await Promise.all([getCandidates(tab.id), getNavigation(tab.id)]);
  const activeJobId = (await chrome.storage.session.get(ACTIVE_JOB_KEY))[ACTIVE_JOB_KEY];
  const candidateViews = await Promise.all(candidates.map(async (candidate) => {
    const descriptor = await getDescriptor(tab.id!, candidate.id);
    const classification = descriptor?.classification ?? classifyPlaylistUrl(candidate.url);
    return {
      id: candidate.id,
      title: candidate.pageTitle,
      preview: candidatePreview(candidate, classification),
      classification,
      observedAt: candidate.observedAt
    };
  }));
  candidateViews.sort((left, right) =>
    rankClassification(right.classification) - rankClassification(left.classification) || right.observedAt - left.observedAt
  );
  return {
    isKinoTab: true,
    tabId: tab.id,
    title: tab.title ?? "Kino.pub stream",
    ...(navigation ? { navigationId: navigation.id } : {}),
    candidates: candidateViews,
    nativeStatus: await getStatus(),
    cdnAccessGranted: await chrome.permissions.contains({ origins: ["https://*/*"] }),
    ...(typeof activeJobId === "string" ? { activeJobId } : {}),
    offline: await getOfflineState()
  };
}

function sameKinoPage(left: string, right: string): boolean {
  const a = new URL(left);
  const b = new URL(right);
  return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
}

async function retryOffline(jobId: string): Promise<void> {
  const offline = await getOfflineState();
  const job = offline.queue.find((item) => item.id === jobId);
  if (!job) throw new Error("Offline job was not found");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !isKinoPageUrl(tab.url) || !sameKinoPage(job.source.pageUrl, tab.url as string)) {
    throw new Error("Open this movie's Kino page, reload it, and play for a few seconds before retrying");
  }
  const candidates = await getCandidates(tab.id);
  for (const current of candidates) {
    const descriptor = await getDescriptor(tab.id, current.id);
    if (!descriptor || (descriptor.classification !== "master" && descriptor.classification !== "video")) continue;
    const refreshed = selectQuality(descriptor, job.quality);
    const response = await requestNative("offlineRetry", { jobId, descriptor: refreshed });
    const snapshot = await setOfflineState(response);
    if (!snapshot) throw new Error("Native helper returned invalid offline state");
    return;
  }
  throw new Error("No inspected video playlist is ready; play the Kino video for a few seconds and retry");
}

async function addOverride(raw: string): Promise<PopupState> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.pathname.toLowerCase().includes(".m3u8") || url.username || url.password) {
    throw new Error("Manual URL must be an HTTPS .m3u8 URL without embedded credentials");
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !isKinoPageUrl(tab.url)) throw new Error("Manual overrides require an active Kino.pub tab");
  const observedCandidates = await getCandidates(tab.id);
  if (!isAllowedManualOverride(url.toString(), tab.url as string, observedCandidates)) {
    throw new Error("Manual overrides must use Kino.pub or a CDN origin already observed in the active tab");
  }
  const navigation = await ensureNavigation(tab.id, tab.url as string);
  const requestId = `manual:${crypto.randomUUID()}`;
  const added = await upsertCandidate(StreamCandidateSchema.parse({
    id: `${tab.id}:${navigation.id}:${requestId}`,
    tabId: tab.id,
    navigationId: navigation.id,
    requestId,
    url: url.toString(),
    initiator: new URL(tab.url as string).origin,
    pageUrl: tab.url,
    pageTitle: tab.title ?? "Kino.pub stream",
    observedAt: Date.now(),
    access: { headers: [] }
  }));
  try {
    postNative(makeEnvelope("probe", { candidate: added }));
    await setStatus("Inspecting manual stream…");
  } catch (error) {
    await setStatus(safeError(error));
  }
  return popupState();
}

function selectQuality(descriptor: StreamDescriptor, quality: string): StreamDescriptor {
  if (quality === "auto") return descriptor;
  const requestedHeight = Number.parseInt(quality, 10);
  if (!Number.isFinite(requestedHeight)) return descriptor;
  const variants = descriptor.variants
    .filter((variant) => variant.height !== undefined && variant.height <= requestedHeight)
    .sort((left, right) => (right.height ?? 0) - (left.height ?? 0) || (right.bandwidth ?? 0) - (left.bandwidth ?? 0));
  const selected = variants[0];
  if (!selected) return descriptor;
  const base = descriptor.masterUrl ?? descriptor.candidate.url;
  return StreamDescriptorSchema.parse({ ...descriptor, masterUrl: new URL(selected.uri, base).toString(), variants: [selected] });
}

async function runCommand(request: Extract<PopupRequest, { type: "run" }>): Promise<string> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !isKinoPageUrl(tab.url)) throw new Error("Open the matching Kino.pub tab before starting a job");
  const candidate = (await getCandidates(tab.id)).find((item) => item.id === request.candidateId);
  if (!candidate) throw new Error("The selected stream is no longer available; start Kino.pub playback again");
  const storedDescriptor = await getDescriptor(tab.id, candidate.id);
  if (!storedDescriptor) {
    postNative(makeEnvelope("probe", { candidate }));
    throw new Error("The selected stream is still being inspected; try again in a moment");
  }
  const descriptor = selectQuality(storedDescriptor, request.quality);
  const jobId = crypto.randomUUID();
  const playback = PlaybackOptionsSchema.parse(request.playback);
  const nativeCommand = request.action === "play"
    ? makeEnvelope("play", { descriptor, options: playback }, jobId)
    : makeEnvelope("download", { descriptor, options: DownloadOptionsSchema.parse(request.download) }, jobId);
  await chrome.storage.session.set({ [ACTIVE_JOB_KEY]: jobId });
  try {
    postNative(nativeCommand);
    await setStatus(request.action === "play" ? "Starting external playback…" : "Starting download…");
  } catch (error) {
    await chrome.storage.session.remove(ACTIVE_JOB_KEY);
    throw error;
  }
  return jobId;
}

async function handlePopupRequest(request: PopupRequest): Promise<unknown> {
  switch (request.type) {
    case "getState":
      return popupState();
    case "addOverride":
      return addOverride(request.url);
    case "run":
      return { jobId: await runCommand(request) };
    case "cancel":
      postNative(makeEnvelope("cancel", { jobId: request.jobId }));
      await chrome.storage.session.remove(ACTIVE_JOB_KEY);
      await setStatus("Cancelling media job…");
      return { jobId: request.jobId };
    case "offlineRetry":
      await retryOffline(request.jobId);
      return { jobId: request.jobId };
    case "offlineRemove": {
      const response = await requestNative("offlineRemove", { jobId: request.jobId });
      await setOfflineState(response);
      return { jobId: request.jobId };
    }
    case "libraryPlay":
      await requestNative("libraryPlay", { libraryId: request.libraryId, player: request.player });
      return { libraryId: request.libraryId };
    case "libraryReveal":
      await requestNative("libraryReveal", { libraryId: request.libraryId });
      return { libraryId: request.libraryId };
    case "libraryDelete": {
      const response = await requestNative("libraryDelete", { libraryId: request.libraryId });
      await setOfflineState(response);
      return { libraryId: request.libraryId };
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: PopupResponse) => void) => {
  if (!isPopupRequest(message)) return false;
  void handlePopupRequest(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});

void initializeSessionStorage().then(() => {
  void setStatus("Native helper is connecting…");
  connectNative();
});
