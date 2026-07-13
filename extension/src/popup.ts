import {
  DownloadOptionsSchema,
  PlaybackOptionsSchema,
  type DownloadOptions,
  type PlaybackOptions
} from "@kinobridge/shared";
import type { CandidateView, PopupRequest, PopupResponse, PopupState, TrackView } from "./messages.js";
import { automaticMovieDefaults } from "./defaults.js";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
}

const title = byId<HTMLHeadingElement>("title");
const status = byId<HTMLParagraphElement>("status");
const controls = byId<HTMLFormElement>("controls");
const candidate = byId<HTMLSelectElement>("candidate");
const audioTrack = byId<HTMLSelectElement>("audio-track");
const subtitleTrack = byId<HTMLSelectElement>("subtitle-track");
const manualUrl = byId<HTMLInputElement>("manual-url");
const playButton = byId<HTMLButtonElement>("play");
const downloadButton = byId<HTMLButtonElement>("download");
const cancelButton = byId<HTMLButtonElement>("cancel");
const enableCdnButton = byId<HTMLButtonElement>("enable-cdn");
const cdnNote = byId<HTMLParagraphElement>("cdn-note");
const offlineQueue = byId<HTMLDivElement>("offline-queue");
const offlineLibrary = byId<HTMLDivElement>("offline-library");
let currentState: PopupState | undefined;
let currentJobId: string | undefined;
let defaultsAppliedTitle: string | undefined;

async function send<T>(request: PopupRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as PopupResponse<T>;
  if (!response?.ok) throw new Error(response?.error ?? "Extension request failed");
  return response.data as T;
}

function setBusy(busy: boolean): void {
  playButton.disabled = busy || !currentState?.isKinoTab || currentState.candidates.length === 0;
  downloadButton.disabled = playButton.disabled;
}

function setStatus(message: string): void {
  status.textContent = message;
}

function trackLabel(track: TrackView): string {
  const identity = track.name ?? track.language ?? track.id;
  const language = track.language && track.language.toLowerCase() !== identity.toLowerCase() ? ` · ${track.language}` : "";
  return `${identity}${language}${track.default ? " · default" : ""}${track.forced ? " · forced" : ""}`;
}

function isEnglish(track: TrackView): boolean {
  const language = track.language?.toLowerCase().split("-", 1)[0];
  const name = track.name?.trim().toLowerCase();
  return language === "en" || language === "eng" || name === "english";
}

function isOriginal(track: TrackView): boolean {
  return /(?:^|[\s([\]_-])(?:original(?:\s+(?:audio|soundtrack|version))?|originale|version originale|оригинал(?:ьная)?(?:\s+дорожка)?|ov)(?:$|[\s)\[\]_-])/iu.test(track.name?.normalize("NFKC").toLowerCase() ?? "");
}

function renderTrackOptions(view: CandidateView | undefined): void {
  const previousAudio = audioTrack.value;
  const previousSubtitle = subtitleTrack.value;
  const audio = view?.tracks.filter((track) => track.type === "audio") ?? [];
  const subtitles = view?.tracks.filter((track) => track.type === "subtitle") ?? [];
  const fill = (select: HTMLSelectElement, tracks: TrackView[], automatic: string): void => {
    select.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = automatic;
    select.append(auto);
    for (const track of tracks) {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = trackLabel(track);
      select.append(option);
    }
  };
  fill(audioTrack, audio, "Automatic: Original, then English");
  fill(subtitleTrack, subtitles, "Automatic: English");
  audioTrack.value = audio.some((track) => track.id === previousAudio)
    ? previousAudio
    : audio.find(isOriginal)?.id ?? audio.find(isEnglish)?.id ?? "";
  subtitleTrack.value = subtitles.some((track) => track.id === previousSubtitle)
    ? previousSubtitle
    : subtitles.find((track) => isEnglish(track) && !track.forced)?.id ?? subtitles.find(isEnglish)?.id ?? "";
}

function renderState(state: PopupState): void {
  currentState = state;
  currentJobId = state.activeJobId;
  title.textContent = state.title;
  const filenameInput = byId<HTMLInputElement>("filename");
  if (state.isKinoTab && defaultsAppliedTitle !== state.title) {
    defaultsAppliedTitle = state.title;
    const defaults = automaticMovieDefaults(state.title);
    filenameInput.value = defaults.filename;
    byId<HTMLInputElement>("download-dir").value = defaults.outputDirectory;
    if (defaults.outputProfile) {
      byId<HTMLSelectElement>("input-stereo").value = defaults.inputStereo!;
      byId<HTMLSelectElement>("output-profile").value = defaults.outputProfile;
      byId<HTMLInputElement>("output-width").value = String(defaults.outputWidth);
      byId<HTMLInputElement>("output-height").value = String(defaults.outputHeight);
      byId<HTMLInputElement>("aspect").value = String(defaults.aspectCorrection);
      byId<HTMLInputElement>("h-align").value = String(defaults.horizontalAlignment);
      byId<HTMLInputElement>("v-align").value = String(defaults.verticalAlignment);
      byId<HTMLInputElement>("zoom").value = String(defaults.zoom);
      byId<HTMLSelectElement>("codec").value = defaults.codec!;
    }
  }
  const previousCandidate = candidate.value;
  candidate.replaceChildren();
  for (const item of state.candidates) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.preview;
    candidate.append(option);
  }
  if (state.candidates.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = state.isKinoTab ? "Detecting the Kino stream automatically…" : "No active Kino.pub tab";
    candidate.append(option);
  }
  if (state.candidates.some((item) => item.id === previousCandidate)) candidate.value = previousCandidate;
  renderTrackOptions(state.candidates.find((item) => item.id === candidate.value));
  controls.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")
    .forEach((element) => { element.disabled = !state.isKinoTab; });
  cancelButton.disabled = !currentJobId;
  setStatus(state.nativeStatus);
  enableCdnButton.disabled = state.cdnAccessGranted;
  enableCdnButton.textContent = state.cdnAccessGranted ? "Kino CDN detection enabled" : "Enable Kino CDN detection";
  cdnNote.textContent = state.cdnAccessGranted
    ? "Playlist observation is enabled for Kino's CDN hosts."
    : "Required once so KinoBridge can observe playlists hosted by Kino's changing CDN domains.";
  setBusy(false);
  renderOffline(state);
}

function button(label: string, action: string, id: string, danger = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `${danger ? "danger" : "secondary"} compact`;
  element.textContent = label;
  element.dataset.action = action;
  element.dataset.id = id;
  return element;
}

function renderOffline(state: PopupState): void {
  offlineQueue.replaceChildren();
  for (const item of state.offline.queue) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("p");
    heading.className = "card-title";
    heading.textContent = item.source.title;
    const meta = document.createElement("p");
    meta.className = "card-meta";
    const percent = item.progress?.percent === undefined ? "" : ` · ${Math.round(item.progress.percent)}%`;
    meta.textContent = `${item.state}${percent} · ${item.quality} · ${item.options.filename}.mkv`;
    card.append(heading, meta);
    if (item.progress?.percent !== undefined) {
      const progress = document.createElement("div");
      progress.className = "progress";
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, item.progress.percent))}%`;
      progress.append(fill);
      card.append(progress);
    }
    if (item.error) {
      const error = document.createElement("p");
      error.className = "card-error";
      error.textContent = item.error;
      card.append(error);
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    if (item.state === "running" || item.state === "queued") actions.append(button("Cancel", "cancel", item.id, true));
    if (["interrupted", "failed", "canceled"].includes(item.state)) actions.append(button("Retry from current Kino tab", "retry", item.id));
    if (item.state !== "running") actions.append(button("Remove", "remove-job", item.id, true));
    card.append(actions);
    offlineQueue.append(card);
  }
  if (state.offline.queue.length === 0) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No downloads yet."; offlineQueue.append(empty);
  }

  offlineLibrary.replaceChildren();
  for (const entry of state.offline.library) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("p"); heading.className = "card-title"; heading.textContent = entry.title;
    const meta = document.createElement("p"); meta.className = "card-meta";
    const gib = entry.sizeBytes / (1024 ** 3);
    const audio = entry.tracks.filter((track) => track.type === "audio").map((track) => track.language).filter(Boolean).join(", ");
    meta.textContent = `${gib >= 0.1 ? `${gib.toFixed(1)} GB` : `${Math.round(entry.sizeBytes / (1024 ** 2))} MB`}${audio ? ` · audio ${audio}` : ""}`;
    const actions = document.createElement("div"); actions.className = "card-actions";
    actions.append(button("Play", "play-library", entry.id), button("Reveal", "reveal-library", entry.id), button("Delete", "delete-library", entry.id, true));
    card.append(heading, meta, actions);
    offlineLibrary.append(card);
  }
  if (state.offline.library.length === 0) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Downloaded movies will appear here."; offlineLibrary.append(empty);
  }
}

function listValue(id: string): string[] {
  return byId<HTMLInputElement>(id).value.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 8);
}

function numberValue(id: string): number {
  return byId<HTMLInputElement>(id).valueAsNumber;
}

function playbackOptions(): PlaybackOptions {
  return PlaybackOptionsSchema.parse({
    player: byId<HTMLSelectElement>("player").value,
    ...(audioTrack.value ? { audioTrackId: audioTrack.value } : {}),
    ...(subtitleTrack.value ? { subtitleTrackId: subtitleTrack.value } : {}),
    audioLanguages: listValue("audio"),
    subtitleLanguages: listValue("subtitles"),
    subtitlesEnabled: byId<HTMLInputElement>("subtitles-enabled").checked,
    forcedSubtitlesOnly: byId<HTMLInputElement>("forced-only").checked,
    inputStereo: byId<HTMLSelectElement>("input-stereo").value,
    eyeOrder: byId<HTMLSelectElement>("eye-order").value,
    outputProfile: byId<HTMLSelectElement>("output-profile").value,
    outputWidth: numberValue("output-width"),
    outputHeight: numberValue("output-height"),
    aspectCorrection: numberValue("aspect"),
    horizontalAlignment: numberValue("h-align"),
    verticalAlignment: numberValue("v-align"),
    zoom: numberValue("zoom"),
    refreshRate: numberValue("refresh-rate")
  });
}

candidate.addEventListener("change", () => {
  renderTrackOptions(currentState?.candidates.find((item) => item.id === candidate.value));
});

function applyXrealDefaults(): void {
  byId<HTMLSelectElement>("output-profile").value = "xreal-sbs";
  byId<HTMLInputElement>("output-width").value = "3840";
  byId<HTMLInputElement>("output-height").value = "1080";
  byId<HTMLInputElement>("aspect").value = "1";
  byId<HTMLInputElement>("h-align").value = "0";
  byId<HTMLInputElement>("v-align").value = "-78";
  byId<HTMLInputElement>("zoom").value = "1";
  byId<HTMLSelectElement>("codec").value = "h264-videotoolbox";
}

byId<HTMLSelectElement>("input-stereo").addEventListener("change", (event) => {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (value === "half-tb" || value === "full-tb") applyXrealDefaults();
});
byId<HTMLSelectElement>("output-profile").addEventListener("change", (event) => {
  if ((event.currentTarget as HTMLSelectElement).value === "xreal-sbs") applyXrealDefaults();
});

function downloadOptions(playback: PlaybackOptions): DownloadOptions {
  return DownloadOptionsSchema.parse({
    ...playback,
    outputDirectory: byId<HTMLInputElement>("download-dir").value,
    filename: byId<HTMLInputElement>("filename").value,
    container: "mkv",
    codec: byId<HTMLSelectElement>("codec").value,
    embedSubtitles: byId<HTMLInputElement>("embed-subtitles").checked
  });
}

async function run(action: "play" | "download"): Promise<void> {
  if (!candidate.value) throw new Error("Select or add a playlist first");
  const playback = playbackOptions();
  const request: PopupRequest = {
    type: "run",
    action,
    candidateId: candidate.value,
    quality: byId<HTMLSelectElement>("quality").value,
    playback,
    ...(action === "download" ? { download: downloadOptions(playback) } : {})
  };
  setBusy(true);
  setStatus(action === "play" ? "Starting external player…" : "Starting download…");
  try {
    const result = await send<{ jobId: string }>(request);
    currentJobId = result.jobId;
    cancelButton.disabled = false;
  } finally {
    setBusy(false);
  }
}

controls.addEventListener("submit", (event) => {
  event.preventDefault();
  void run("play").catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Playback failed"));
});

downloadButton.addEventListener("click", () => {
  void run("download").catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Download failed"));
});

cancelButton.addEventListener("click", () => {
  void (async () => {
    if (!currentJobId) return;
    const jobId = currentJobId;
    await send({ type: "cancel", jobId });
    currentJobId = undefined;
    cancelButton.disabled = true;
    setStatus("Cancellation requested…");
  })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not cancel job"));
});

byId<HTMLButtonElement>("add-override").addEventListener("click", () => {
  void (async () => {
    const url = new URL(manualUrl.value);
    if (url.protocol !== "https:" || !url.pathname.toLowerCase().includes(".m3u8")) {
      throw new Error("Enter an HTTPS .m3u8 URL");
    }
    const originPattern = `${url.origin}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) throw new Error("Stream host access was not granted");
    const state = await send<PopupState>({ type: "addOverride", url: url.toString() });
    manualUrl.value = "";
    renderState(state);
  })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not add playlist"));
});

enableCdnButton.addEventListener("click", () => {
  void (async () => {
    const granted = await chrome.permissions.request({ origins: ["https://*/*"] });
    if (!granted) throw new Error("Kino CDN access was not granted");
    renderState(await send<PopupState>({ type: "getState" }));
  })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not enable CDN detection"));
});

async function refreshOffline(): Promise<void> {
  renderState(await send<PopupState>({ type: "getState" }));
}

byId<HTMLButtonElement>("refresh-offline").addEventListener("click", () => {
  void refreshOffline().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not refresh offline state"));
});

offlineQueue.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLButtonElement ? event.target : undefined;
  const id = target?.dataset.id;
  const action = target?.dataset.action;
  if (!id || !action) return;
  void (async () => {
    if (action === "cancel") await send({ type: "cancel", jobId: id });
    else if (action === "retry") await send({ type: "offlineRetry", jobId: id });
    else if (action === "remove-job") await send({ type: "offlineRemove", jobId: id });
    setStatus(action === "retry" ? "Offline download queued with fresh stream access…" : "Offline queue updated");
    await refreshOffline();
  })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Offline action failed"));
});

offlineLibrary.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLButtonElement ? event.target : undefined;
  const id = target?.dataset.id;
  const action = target?.dataset.action;
  if (!id || !action) return;
  void (async () => {
    if (action === "play-library") await send({ type: "libraryPlay", libraryId: id, player: byId<HTMLSelectElement>("player").value as "mpv" | "vlc" | "iina" });
    else if (action === "reveal-library") await send({ type: "libraryReveal", libraryId: id });
    else if (action === "delete-library") {
      if (!window.confirm("Delete this downloaded movie from disk? This cannot be undone.")) return;
      await send({ type: "libraryDelete", libraryId: id });
      await refreshOffline();
    }
  })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Library action failed"));
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") return;
  const record = message as Record<string, unknown>;
  if (record.type === "statusChanged" && typeof record.status === "string") {
    setStatus(record.status);
    if (/completed|failed|cancell/i.test(record.status)) {
      currentJobId = undefined;
      cancelButton.disabled = true;
    }
  }
  if (record.type === "candidatesChanged" || record.type === "offlineChanged") void send<PopupState>({ type: "getState" }).then(renderState).catch(() => undefined);
});

void (async () => {
  let state = await send<PopupState>({ type: "getState" });
  renderState(state);
  if (state.isKinoTab && !state.candidates.some((item) => item.ready)) {
    setStatus("Capturing the authenticated stream automatically…");
    state = await send<PopupState>({ type: "prepareStream" });
    renderState(state);
  }
})().catch((error: unknown) => {
  if (!currentState) title.textContent = "KinoBridge unavailable";
  setStatus(error instanceof Error ? error.message : "Could not load extension state");
  setBusy(false);
});
