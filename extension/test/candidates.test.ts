import { describe, expect, it } from "vitest";
import type { StreamCandidate } from "@kinobridge/shared";
import { candidatePreview, classifyPlaylistUrl, isAllowedManualOverride, isHlsPlaylistUrl, isKinoPageUrl, sortCandidates } from "../src/candidates.js";

function candidate(url: string, observedAt = Date.now()): StreamCandidate {
  return {
    id: url,
    tabId: 1,
    navigationId: "nav",
    requestId: url,
    url,
    pageUrl: "https://kino.pub/item/1",
    pageTitle: "Fixture",
    observedAt,
    access: { headers: [] }
  };
}

describe("Kino page recognition", () => {
  it("accepts only HTTPS kino.pub hosts", () => {
    expect(isKinoPageUrl("https://kino.pub/item/1")).toBe(true);
    expect(isKinoPageUrl("https://video.kino.pub/watch")).toBe(true);
    expect(isKinoPageUrl("https://zerkalo.xyz/item/view/12345/s0e1")).toBe(true);
    expect(isKinoPageUrl("https://video.zerkalo.xyz/watch")).toBe(true);
    expect(isKinoPageUrl("http://kino.pub/item/1")).toBe(false);
    expect(isKinoPageUrl("https://kino.pub.attacker.example/")).toBe(false);
    expect(isKinoPageUrl("https://zerkalo.xyz.attacker.example/")).toBe(false);
  });
});

describe("playlist classification", () => {
  it.each([
    ["https://cdn.example/master.m3u8?token=secret", "master"],
    ["https://cdn.example/video-file.mp4/index-v1.m3u8", "video"],
    ["https://cdn.example/subtitles/fr/subtitle.srt/index.m3u8", "subtitle"],
    ["https://cdn.example/audio/fr/index.m3u8", "audio"],
    ["https://cdn.example/movie.mp4/index-a1.m3u8", "audio"],
    ["https://cdn.example/opaque/index.m3u8", "unknown"]
  ])("classifies %s", (url, expected) => expect(classifyPlaylistUrl(url)).toBe(expected));

  it("rejects non-HLS and active URL schemes", () => {
    expect(isHlsPlaylistUrl("https://cdn.example/video.mp4")).toBe(false);
    expect(isHlsPlaylistUrl("javascript:alert(1).m3u8")).toBe(false);
  });

  it("ranks master and video playlists ahead of subtitle playlists", () => {
    const sorted = sortCandidates([
      candidate("https://cdn.example/subtitles/fr/index.m3u8"),
      candidate("https://cdn.example/video/index-v1.m3u8"),
      candidate("https://cdn.example/master.m3u8")
    ]);
    expect(sorted.map((item) => classifyPlaylistUrl(item.url))).toEqual(["master", "video", "subtitle"]);
  });

  it("does not expose signed query strings in popup previews", () => {
    expect(candidatePreview(candidate("https://cdn.example/master.m3u8?token=secret"))).not.toContain("secret");
  });

  it("handles malformed percent escapes without breaking the popup", () => {
    expect(candidatePreview(candidate("https://cdn.example/%E0%A4%A/master.m3u8"))).toContain("master.m3u8");
  });

  it("permits overrides only for Kino or an origin observed in the active tab", () => {
    const observed = [candidate("https://video.cdn.example/master.m3u8?token=old")];
    expect(isAllowedManualOverride("https://video.cdn.example/alternate.m3u8?token=new", "https://kino.pub/item/1", observed)).toBe(true);
    expect(isAllowedManualOverride("https://kino.pub/fallback.m3u8", "https://kino.pub/item/1", observed)).toBe(true);
    expect(isAllowedManualOverride("https://unrelated.example/video.m3u8", "https://kino.pub/item/1", observed)).toBe(false);
    expect(isAllowedManualOverride("file:///tmp/video.m3u8", "https://kino.pub/item/1", observed)).toBe(false);
  });
});
