import { describe, expect, it } from "vitest";
import { PlaybackOptionsSchema, StreamDescriptorSchema } from "@kinobridge/shared";
import { selectPlaybackResources } from "../src/media-selection.js";

const descriptor = StreamDescriptorSchema.parse({
  source: "kino.pub",
  candidate: {
    id: "candidate",
    tabId: 1,
    navigationId: "nav",
    requestId: "request",
    url: "https://master.example/master.m3u8",
    pageUrl: "https://kino.pub/item/1",
    pageTitle: "Fixture",
    observedAt: 1,
    access: { headers: [] }
  },
  classification: "master",
  masterUrl: "https://master.example/master.m3u8",
  variants: [
    { uri: "https://video.example/720.m3u8", height: 720, bandwidth: 2_000_000 },
    { uri: "https://video.example/1080.m3u8", height: 1080, bandwidth: 5_000_000 }
  ],
  tracks: [
    { id: "ru", type: "audio", uri: "https://audio.example/ru.m3u8", language: "rus", name: "Russian", default: true },
    { id: "original", type: "audio", uri: "https://audio.example/en.m3u8", language: "eng", name: "Original" },
    { id: "sub-vie", type: "subtitle", uri: "https://subs.example/vie.m3u8", language: "vie", name: "Vietnamese", default: true },
    { id: "sub-en", type: "subtitle", uri: "https://subs.example/en.m3u8", language: "eng", name: "English" },
    { id: "sub-en-forced", type: "subtitle", uri: "https://subs.example/en-forced.m3u8", language: "eng", name: "English forced", forced: true }
  ]
});

describe("playback resource selection", () => {
  it("selects one best video, preferred audio, and preferred subtitle", () => {
    const selected = selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: ["fr", "en"], subtitleLanguages: ["en"] }));
    expect(selected.videoUrl).toContain("1080");
    expect(selected.audioTrack?.id).toBe("original");
    expect(selected.subtitleTrack?.id).toBe("sub-en");
  });

  it("selects exact Original audio and English subtitles over Russian and Vietnamese defaults", () => {
    const selected = selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({
      audioTrackId: "original",
      subtitleTrackId: "sub-en",
      audioLanguages: ["original", "en"],
      subtitleLanguages: ["en"]
    }));
    expect(selected.audioTrack).toMatchObject({ id: "original", language: "eng" });
    expect(selected.subtitleTrack).toMatchObject({ id: "sub-en", language: "eng", forced: false });
  });

  it("normalizes ISO-639 aliases and recognizes an explicitly named Original rendition", () => {
    const english = selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: ["en"], subtitleLanguages: ["en"] }));
    expect(english.audioTrack?.language).toBe("eng");
    expect(english.subtitleTrack?.language).toBe("eng");
    expect(selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: ["original"], subtitleLanguages: ["en"] })).audioTrack?.id).toBe("original");
  });

  it("fails instead of silently substituting a different requested language or missing exact track", () => {
    expect(() => selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: ["ja"], subtitleLanguages: ["en"] }))).toThrow(/requested audio tracks/i);
    expect(() => selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioTrackId: "missing", subtitleLanguages: ["en"] }))).toThrow(/selected audio track/i);
    expect(() => selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: ["en"], subtitleLanguages: ["ja"] }))).toThrow(/requested subtitle tracks/i);
  });

  it("uses HLS default/autoselect only when no preferences were requested", () => {
    const selected = selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: [], subtitleLanguages: [] }));
    expect(selected.audioTrack?.id).toBe("ru");
    expect(selected.subtitleTrack?.id).toBe("sub-vie");
  });

  it("restricts tracks to the selected variant rendition groups and preserves URI-less embedded audio", () => {
    const grouped = StreamDescriptorSchema.parse({
      ...descriptor,
      variants: [{ uri: "https://video.example/1080.m3u8", height: 1080, audioGroupId: "main-audio", subtitleGroupId: "main-subs" }],
      tracks: [
        { id: "embedded-original", type: "audio", groupId: "main-audio", language: "eng", name: "Original" },
        { id: "wrong-group", type: "audio", groupId: "alternate-audio", uri: "https://audio.example/wrong.m3u8", language: "eng", name: "Original" },
        { id: "english-main", type: "subtitle", groupId: "main-subs", uri: "https://subs.example/en.m3u8", language: "eng" }
      ]
    });
    const selected = selectPlaybackResources(grouped, PlaybackOptionsSchema.parse({ audioTrackId: "embedded-original", subtitleTrackId: "english-main" }));
    expect(selected.audioTrack).toMatchObject({ id: "embedded-original" });
    expect(selected.audioTrack?.uri).toBeUndefined();
    expect(() => selectPlaybackResources(grouped, PlaybackOptionsSchema.parse({ audioTrackId: "wrong-group", subtitleTrackId: "english-main" }))).toThrow(/no longer available/i);
  });

  it("omits subtitles when disabled", () => {
    expect(selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ subtitlesEnabled: false })).subtitleTrack).toBeUndefined();
  });
});
