import type { StreamCandidate } from "@kinobridge/shared";

export type PlaylistClassification = "master" | "video" | "audio" | "subtitle" | "unknown";

const KINO_HOST = /(^|\.)(?:kino\.pub|zerkalo\.xyz)$/i;
const SUBTITLE_HINT = /(?:^|\/)(?:subtitles?|subs?)(?:\/|$)|\.(?:srt|vtt)(?:\/|$)/i;
const AUDIO_HINT = /(?:^|\/)(?:audio|audios|sound)(?:\/|$)|(?:^|[-_.\/])audio(?:[-_.\/]|$)|index-a\d+\.m3u8$/i;
const MASTER_HINT = /(?:^|[-_.\/])master(?:[-_.\/]|$)/i;
const VIDEO_HINT = /(?:^|\/)(?:video|videos)(?:\/|$)|index-v\d+\.m3u8$/i;

export function isKinoPageUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && KINO_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function isHlsPlaylistUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.pathname.toLowerCase().includes(".m3u8");
  } catch {
    return false;
  }
}

export function classifyPlaylistUrl(raw: string): PlaylistClassification {
  if (!isHlsPlaylistUrl(raw)) return "unknown";
  const path = new URL(raw).pathname;
  if (SUBTITLE_HINT.test(path)) return "subtitle";
  if (AUDIO_HINT.test(path)) return "audio";
  if (MASTER_HINT.test(path)) return "master";
  if (VIDEO_HINT.test(path)) return "video";
  return "unknown";
}

export function rankCandidate(candidate: StreamCandidate): number {
  const classification = classifyPlaylistUrl(candidate.url);
  const path = new URL(candidate.url).pathname.toLowerCase();
  const freshness = Math.min(20, Math.max(0, (candidate.observedAt - Date.now() + 60_000) / 3_000));
  return rankClassification(classification) + (path.includes("index-v") ? 8 : 0) + freshness;
}

export function rankClassification(classification: PlaylistClassification): number {
  const classScore: Record<PlaylistClassification, number> = {
    master: 100,
    video: 80,
    unknown: 40,
    audio: 10,
    subtitle: 0
  };
  return classScore[classification];
}

export function sortCandidates(candidates: readonly StreamCandidate[]): StreamCandidate[] {
  return [...candidates].sort((left, right) => {
    const score = rankCandidate(right) - rankCandidate(left);
    return score || right.observedAt - left.observedAt;
  });
}

export function candidatePreview(candidate: StreamCandidate, classification = classifyPlaylistUrl(candidate.url)): string {
  const url = new URL(candidate.url);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    decodedPath = url.pathname;
  }
  const path = decodedPath.replace(/[^\x20-\x7e]/g, "?");
  const compact = path.length > 72 ? `…${path.slice(-71)}` : path;
  return `${classification} · ${compact}`;
}

export function isAllowedManualOverride(raw: string, pageUrl: string, observedCandidates: readonly StreamCandidate[]): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.pathname.toLowerCase().includes(".m3u8") || url.username || url.password) return false;
    const allowedOrigins = new Set([
      new URL(pageUrl).origin,
      ...observedCandidates.map((candidate) => new URL(candidate.url).origin)
    ]);
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}
