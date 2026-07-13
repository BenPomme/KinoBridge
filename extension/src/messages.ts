import type { DownloadOptions, OfflineSnapshot, PlaybackOptions, Player } from "@kinobridge/shared";
import type { PlaylistClassification } from "./candidates.js";

export interface CandidateView {
  id: string;
  title: string;
  preview: string;
  classification: PlaylistClassification;
  observedAt: number;
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
  | { type: "addOverride"; url: string }
  | {
      type: "run";
      action: "play" | "download";
      candidateId: string;
      quality: string;
      playback: PlaybackOptions;
      download?: DownloadOptions;
    }
  | { type: "cancel"; jobId: string }
  | { type: "offlineRetry"; jobId: string }
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
  return ["getState", "addOverride", "run", "cancel", "offlineRetry", "offlineRemove", "libraryPlay", "libraryReveal", "libraryDelete"].includes(String(record.type));
}
