import {
  DownloadOptionsSchema,
  PlaybackOptionsSchema,
  type DownloadOptions,
  type PlaybackOptions
} from "@kinobridge/shared";
import type { PopupRequest, PopupResponse, PopupState } from "./messages.js";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
}

const title = byId<HTMLHeadingElement>("title");
const status = byId<HTMLParagraphElement>("status");
const controls = byId<HTMLFormElement>("controls");
const candidate = byId<HTMLSelectElement>("candidate");
const manualUrl = byId<HTMLInputElement>("manual-url");
const playButton = byId<HTMLButtonElement>("play");
const downloadButton = byId<HTMLButtonElement>("download");
const cancelButton = byId<HTMLButtonElement>("cancel");
const enableCdnButton = byId<HTMLButtonElement>("enable-cdn");
const cdnNote = byId<HTMLParagraphElement>("cdn-note");
let currentState: PopupState | undefined;
let currentJobId: string | undefined;

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

function renderState(state: PopupState): void {
  currentState = state;
  currentJobId = state.activeJobId;
  title.textContent = state.title;
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
    option.textContent = state.isKinoTab ? "Start playback to detect HLS" : "No active Kino.pub tab";
    candidate.append(option);
  }
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
  if (record.type === "candidatesChanged") void send<PopupState>({ type: "getState" }).then(renderState).catch(() => undefined);
});

void send<PopupState>({ type: "getState" }).then(renderState).catch((error: unknown) => {
  title.textContent = "KinoBridge unavailable";
  setStatus(error instanceof Error ? error.message : "Could not load extension state");
  setBusy(false);
});
