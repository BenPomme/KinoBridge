import type { DownloadOptions, OfflineSnapshot, PlaybackOptions, Player } from "@kinobridge/shared";
import type { PlaylistClassification } from "./candidates.js";

export interface CandidateView {
  id: string;
  title: string;
  preview: string;
  classification: PlaylistClassification;
  observedAt: number;
  ready: boolean;
  tracks: TrackView[];
}

export interface TrackView {
  id: string;
  type: "audio" | "subtitle";
  name?: string;
  language?: string;
  default: boolean;
  autoselect: boolean;
  forced: boolean;
}

export interface PopupState {
  isKinoTab: boolean;
  tabId?: number;
  title: string;
  navigationId?: string;
  candidates: CandidateView[];
  nativeStatus: string;
  cdnAccessGranted: boolean;
  activeJobId?: string;
  offline: OfflineSnapshot;
}

export type PopupRequest =
  | { type: "getState" }
  | { type: "prepareStream"; sourceTabId: number }
  | { type: "addOverride"; sourceTabId: number; url: string }
  | {
      type: "run";
      sourceTabId: number;
      action: "play" | "download";
      candidateId: string;
      quality: string;
      playback: PlaybackOptions;
      download?: DownloadOptions;
    }
  | { type: "cancel"; jobId: string }
  | { type: "offlineRetry"; sourceTabId: number; jobId: string }
  | { type: "offlineRemove"; jobId: string }
  | { type: "libraryPlay"; libraryId: string; player: Player }
  | { type: "libraryReveal"; libraryId: string }
  | { type: "libraryDelete"; libraryId: string };

export interface PopupResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function isPopupRequest(value: unknown): value is PopupRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = String(record.type);
  if (!["getState", "prepareStream", "addOverride", "run", "cancel", "offlineRetry", "offlineRemove", "libraryPlay", "libraryReveal", "libraryDelete"].includes(type)) return false;
  if (["prepareStream", "addOverride", "run", "offlineRetry"].includes(type)) {
    return Number.isInteger(record.sourceTabId) && Number(record.sourceTabId) >= 0;
  }
  return true;
}
