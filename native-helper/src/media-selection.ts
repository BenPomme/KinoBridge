import type { MediaTrack, PlaybackOptions, StreamDescriptor, Variant } from "@kinobridge/shared";
import { KinoBridgeError } from "./errors.js";

export interface PlaybackResources {
  videoUrl: string;
  audioTrack?: MediaTrack;
  subtitleTrack?: MediaTrack;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: "en",
  fre: "fr", fra: "fr",
  ger: "de", deu: "de",
  spa: "es",
  ita: "it",
  por: "pt",
  rus: "ru",
  vie: "vi",
  ukr: "uk",
  jpn: "ja",
  kor: "ko",
  chi: "zh", zho: "zh",
  dut: "nl", nld: "nl",
  cze: "cs", ces: "cs",
  pol: "pl",
  ara: "ar",
  hin: "hi",
  tur: "tr"
};

const LANGUAGE_NAMES: Record<string, readonly string[]> = {
  en: ["english", "anglais", "английский"],
  fr: ["french", "français", "francais", "французский"],
  de: ["german", "deutsch", "немецкий"],
  es: ["spanish", "español", "espanol", "испанский"],
  ru: ["russian", "русский"],
  vi: ["vietnamese", "tiếng việt", "tieng viet", "вьетнамский"]
};

function normalizedText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalLanguage(value: string | undefined): string | undefined {
  const primary = normalizedText(value).replace(/_/g, "-").split("-", 1)[0];
  if (!primary) return undefined;
  return LANGUAGE_ALIASES[primary] ?? primary;
}

function isOriginal(track: MediaTrack): boolean {
  const name = normalizedText(track.name);
  return /(?:^|[\s([\]_-])(?:original(?:\s+(?:audio|soundtrack|version))?|originale|version originale|оригинал(?:ьная)?(?:\s+дорожка)?|ov)(?:$|[\s)\[\]_-])/iu.test(name);
}

function matchesPreference(track: MediaTrack, rawPreference: string): boolean {
  const preference = normalizedText(rawPreference);
  if (preference === "original") return isOriginal(track);
  const requested = canonicalLanguage(preference);
  if (!requested) return false;
  if (canonicalLanguage(track.language) === requested) return true;
  const name = normalizedText(track.name);
  return (LANGUAGE_NAMES[requested] ?? []).some((candidate) => name === candidate || name.startsWith(`${candidate} `));
}

function preferredTrack(
  tracks: MediaTrack[],
  languages: string[],
  kind: "audio" | "subtitle",
  explicitId: string | undefined,
  forcedOnly = false
): MediaTrack | undefined {
  const eligible = tracks
    .filter((track) => !forcedOnly || track.forced)
    .sort((left, right) => Number(left.forced) - Number(right.forced));
  if (explicitId) {
    const explicit = eligible.find((track) => track.id === explicitId);
    if (!explicit) throw new KinoBridgeError("SELECTED_TRACK_UNAVAILABLE", `The selected ${kind} track is no longer available`);
    return explicit;
  }
  if (eligible.length === 0) return undefined;
  if (languages.length > 0) {
    for (const language of languages) {
      const match = eligible.find((track) => matchesPreference(track, language));
      if (match) return match;
    }
    throw new KinoBridgeError(
      kind === "audio" ? "PREFERRED_AUDIO_UNAVAILABLE" : "PREFERRED_SUBTITLE_UNAVAILABLE",
      kind === "audio"
        ? "None of the requested audio tracks are available; choose an exact soundtrack in KinoBridge"
        : "None of the requested subtitle tracks are available; choose an exact subtitle track or disable subtitles"
    );
  }
  return eligible.find((track) => track.default)
    ?? eligible.find((track) => track.autoselect)
    ?? eligible[0];
}

function bestVariant(variants: Variant[]): Variant | undefined {
  return [...variants].sort((left, right) =>
    (right.height ?? 0) - (left.height ?? 0) || (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
  )[0];
}

function tracksForGroup(tracks: MediaTrack[], type: MediaTrack["type"], groupId: string | undefined): MediaTrack[] {
  const matchingType = tracks.filter((track) => track.type === type);
  return groupId ? matchingType.filter((track) => track.groupId === groupId) : matchingType;
}

export function selectPlaybackResources(descriptor: StreamDescriptor, options: PlaybackOptions): PlaybackResources {
  const variant = bestVariant(descriptor.variants);
  const videoUrl = variant?.uri ?? descriptor.masterUrl ?? descriptor.candidate.url;
  const audioTrack = preferredTrack(
    tracksForGroup(descriptor.tracks, "audio", variant?.audioGroupId),
    options.audioLanguages,
    "audio",
    options.audioTrackId
  );
  const subtitleTrack = options.subtitlesEnabled
    ? preferredTrack(
      tracksForGroup(descriptor.tracks, "subtitle", variant?.subtitleGroupId).filter((track) => track.uri),
      options.subtitleLanguages,
      "subtitle",
      options.subtitleTrackId,
      options.forcedSubtitlesOnly
    )
    : undefined;
  return { videoUrl, ...(audioTrack ? { audioTrack } : {}), ...(subtitleTrack ? { subtitleTrack } : {}) };
}
