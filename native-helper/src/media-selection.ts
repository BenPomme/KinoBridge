import type { MediaTrack, PlaybackOptions, StreamDescriptor, Variant } from "@kinobridge/shared";

export interface PlaybackResources {
  videoUrl: string;
  audioTrack?: MediaTrack;
  subtitleTrack?: MediaTrack;
}

function preferredTrack(tracks: MediaTrack[], languages: string[], forcedOnly = false): MediaTrack | undefined {
  const eligible = tracks.filter((track) => !forcedOnly || track.forced);
  for (const preferred of languages) {
    const normalized = preferred.toLowerCase();
    const match = eligible.find((track) => {
      const language = track.language?.toLowerCase();
      return language === normalized || language?.startsWith(`${normalized}-`);
    });
    if (match) return match;
  }
  return eligible.find((track) => track.default) ?? eligible[0];
}

function bestVariant(variants: Variant[]): Variant | undefined {
  return [...variants].sort((left, right) =>
    (right.height ?? 0) - (left.height ?? 0) || (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
  )[0];
}

export function selectPlaybackResources(descriptor: StreamDescriptor, options: PlaybackOptions): PlaybackResources {
  const videoUrl = bestVariant(descriptor.variants)?.uri ?? descriptor.masterUrl ?? descriptor.candidate.url;
  const audioTrack = preferredTrack(descriptor.tracks.filter((track) => track.type === "audio" && track.uri), options.audioLanguages);
  const subtitleTrack = options.subtitlesEnabled
    ? preferredTrack(descriptor.tracks.filter((track) => track.type === "subtitle" && track.uri), options.subtitleLanguages, options.forcedSubtitlesOnly)
    : undefined;
  return { videoUrl, ...(audioTrack ? { audioTrack } : {}), ...(subtitleTrack ? { subtitleTrack } : {}) };
}
