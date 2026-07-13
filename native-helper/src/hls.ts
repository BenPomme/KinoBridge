import type { MediaTrack, StreamCandidate, StreamDescriptor, Variant } from "@kinobridge/shared";
import { assertSafeUpstream, minimalAccessContext } from "@kinobridge/shared";
import { KinoBridgeError } from "./errors.js";

export interface ParsedHls {
  classification: StreamDescriptor["classification"];
  variants: Variant[];
  tracks: MediaTrack[];
  encrypted: boolean;
  durationSeconds?: number;
}

function attributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  for (const match of input.matchAll(pattern)) {
    const key = match[1];
    const raw = match[2];
    if (key && raw !== undefined) result[key.toUpperCase()] = raw.replace(/^"|"$/g, "");
  }
  return result;
}

function absoluteUri(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

export function parseHls(text: string, baseUrl: string): ParsedHls {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new KinoBridgeError("NOT_HLS", "Response is not an HLS playlist");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants: Variant[] = [];
  const tracks: MediaTrack[] = [];
  let duration = 0;
  let sawDuration = false;
  let encrypted = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = attributes(line.slice(line.indexOf(":") + 1));
      const uri = lines.slice(index + 1).find((next) => !next.startsWith("#"));
      if (!uri) continue;
      const resolution = attrs.RESOLUTION?.match(/^(\d+)x(\d+)$/i);
      variants.push({
        uri: absoluteUri(uri, baseUrl),
        ...(attrs.BANDWIDTH && /^\d+$/.test(attrs.BANDWIDTH) ? { bandwidth: Number(attrs.BANDWIDTH) } : {}),
        ...(resolution?.[1] && resolution[2] ? { width: Number(resolution[1]), height: Number(resolution[2]) } : {}),
        ...(attrs.CODECS ? { codecs: attrs.CODECS } : {}),
        ...(attrs["FRAME-RATE"] && Number.isFinite(Number(attrs["FRAME-RATE"])) ? { frameRate: Number(attrs["FRAME-RATE"]) } : {}),
        ...(attrs.AUDIO ? { audioGroupId: attrs.AUDIO } : {}),
        ...(attrs.SUBTITLES ? { subtitleGroupId: attrs.SUBTITLES } : {})
      });
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = attributes(line.slice(line.indexOf(":") + 1));
      const type = attrs.TYPE?.toUpperCase();
      if (type !== "AUDIO" && type !== "SUBTITLES" && type !== "CLOSED-CAPTIONS") continue;
      tracks.push({
        id: `${attrs["GROUP-ID"] ?? type}:${attrs.NAME ?? attrs.LANGUAGE ?? tracks.length}`,
        type: type === "AUDIO" ? "audio" : "subtitle",
        ...(attrs.URI ? { uri: absoluteUri(attrs.URI, baseUrl) } : {}),
        ...(attrs.LANGUAGE ? { language: attrs.LANGUAGE } : {}),
        ...(attrs.NAME ? { name: attrs.NAME } : {}),
        ...(attrs["GROUP-ID"] ? { groupId: attrs["GROUP-ID"] } : {}),
        default: attrs.DEFAULT?.toUpperCase() === "YES",
        autoselect: attrs.DEFAULT?.toUpperCase() === "YES" || attrs.AUTOSELECT?.toUpperCase() === "YES",
        forced: attrs.FORCED?.toUpperCase() === "YES"
      });
    } else if (line.startsWith("#EXTINF:")) {
      const value = Number(line.slice(8).split(",", 1)[0]);
      if (Number.isFinite(value) && value >= 0) {
        duration += value;
        sawDuration = true;
      }
    } else if (line.startsWith("#EXT-X-KEY:") && !/METHOD=NONE(?:,|$)/i.test(line)) {
      encrypted = true;
    }
  }

  const codecs = variants.map((variant) => variant.codecs?.toLowerCase() ?? "").join(",");
  const segmentUris = lines.filter((line) => !line.startsWith("#")).join("\n").toLowerCase();
  const onlySubtitleSegments = /(?:wvtt|stpp)/.test(codecs) || /(?:^|[/?])[^?\n]+\.(?:vtt|webvtt|ttml)(?:\?|$)/m.test(segmentUris) || /#EXT-X-MEDIA:.*TYPE=SUBTITLES/i.test(text) && variants.length === 0;
  const onlyAudioSegments = /(?:mp4a|ac-3|ec-3|opus)/.test(codecs) && !/(?:avc|hevc|hvc1|hev1|vp9|av01)/.test(codecs) || /(?:^|[/?])[^?\n]+\.(?:aac|ac3|eac3|m4a)(?:\?|$)/m.test(segmentUris);
  const classification: ParsedHls["classification"] = variants.length > 0 || tracks.length > 0
    ? "master"
    : onlySubtitleSegments ? "subtitle"
      : onlyAudioSegments ? "audio"
        : lines.some((line) => line.startsWith("#EXTINF:")) ? "video" : "unknown";

  return { classification, variants, tracks, encrypted, ...(sawDuration ? { durationSeconds: duration } : {}) };
}

export function requestHeaders(candidate: StreamCandidate): Record<string, string> {
  const access = minimalAccessContext(candidate.access);
  const headers = {
    accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
    "accept-encoding": "identity",
    ...(access.referer ? { referer: access.referer } : {}),
    ...(access.userAgent ? { "user-agent": access.userAgent } : {}),
    ...(access.cookie ? { cookie: access.cookie } : {}),
    ...Object.fromEntries(access.headers.map((header) => [header.name.toLowerCase(), header.value]))
  };
  for (const value of Object.values(headers)) {
    if (/[\r\n]/.test(value)) throw new KinoBridgeError("INVALID_HEADER", "Access headers may not contain line breaks");
  }
  return headers;
}

export async function fetchPlaylist(candidate: StreamCandidate, signal?: AbortSignal): Promise<{ text: string; finalUrl: string }> {
  const allowed = new Set([new URL(candidate.url).origin]);
  let current: URL;
  try {
    current = assertSafeUpstream(candidate.url, allowed);
  } catch {
    throw new KinoBridgeError("UNSAFE_PLAYLIST_URL", "The selected playlist URL is outside the authorized HTTPS origin");
  }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, { headers: requestHeaders(candidate), redirect: "manual", ...(signal ? { signal } : {}) });
    } catch {
      throw new KinoBridgeError("PLAYLIST_FETCH_FAILED", "The authenticated playlist request could not be completed", true);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new KinoBridgeError("UPSTREAM_REDIRECT", "Upstream redirect could not be followed");
      try {
        current = assertSafeUpstream(new URL(location, current).toString(), allowed);
      } catch {
        throw new KinoBridgeError("UNSAFE_PLAYLIST_REDIRECT", "The playlist redirected outside its authorized origin");
      }
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new KinoBridgeError("AUTH_EXPIRED", "Stream authorization expired", true);
    if (!response.ok) throw new KinoBridgeError("UPSTREAM_ERROR", `Upstream returned HTTP ${response.status}`, response.status >= 500);
    return { text: await response.text(), finalUrl: current.toString() };
  }
  throw new KinoBridgeError("UPSTREAM_REDIRECT", "Too many upstream redirects");
}

export async function probeCandidate(candidate: StreamCandidate, signal?: AbortSignal): Promise<StreamDescriptor> {
  const fetched = await fetchPlaylist(candidate, signal);
  const parsed = parseHls(fetched.text, fetched.finalUrl);
  return {
    source: "kino.pub",
    candidate,
    classification: parsed.classification,
    ...(parsed.classification === "master" ? { masterUrl: fetched.finalUrl } : {}),
    variants: parsed.variants,
    tracks: parsed.tracks,
    stereo: "unknown",
    encrypted: parsed.encrypted,
    ...(parsed.durationSeconds === undefined ? {} : { durationSeconds: parsed.durationSeconds })
  };
}
