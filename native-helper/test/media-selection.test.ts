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
    { id: "ru", type: "audio", uri: "https://audio.example/ru.m3u8", language: "ru", default: true },
    { id: "en", type: "audio", uri: "https://audio.example/en.m3u8", language: "en" },
    { id: "sub-en", type: "subtitle", uri: "https://subs.example/en.m3u8", language: "en" }
  ]
});

describe("playback resource selection", () => {
  it("selects one best video, preferred audio, and preferred subtitle", () => {
    const selected = selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ audioLanguages: ["fr", "en"], subtitleLanguages: ["en"] }));
    expect(selected.videoUrl).toContain("1080");
    expect(selected.audioTrack?.language).toBe("en");
    expect(selected.subtitleTrack?.language).toBe("en");
  });

  it("omits subtitles when disabled", () => {
    expect(selectPlaybackResources(descriptor, PlaybackOptionsSchema.parse({ subtitlesEnabled: false })).subtitleTrack).toBeUndefined();
  });
});
