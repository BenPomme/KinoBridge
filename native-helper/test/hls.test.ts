import { describe, expect, it, vi } from "vitest";
import { StreamCandidateSchema } from "@kinobridge/shared";
import { fetchPlaylist, parseHls } from "../src/hls.js";

describe("HLS parsing", () => {
  it("classifies a master and resolves variants and tracks", () => {
    const parsed = parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",LANGUAGE="eng",DEFAULT=YES
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",AUTOSELECT=YES,URI="../subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=23.976,AUDIO="audio",SUBTITLES="subs"
video/main.m3u8
`, "https://media.example.test/show/master.m3u8?token=secret");
    expect(parsed.classification).toBe("master");
    expect(parsed.variants[0]).toMatchObject({ uri: "https://media.example.test/show/video/main.m3u8", width: 1920, height: 1080, audioGroupId: "audio", subtitleGroupId: "subs" });
    expect(parsed.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "audio", language: "eng", default: true, autoselect: true, name: "Original" }),
      expect.objectContaining({ type: "subtitle", language: "eng", autoselect: true, uri: "https://media.example.test/subs/en.m3u8" })
    ]));
  });

  it("detects encrypted media duration", () => {
    const parsed = parseHls(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4.5,
one.ts
#EXTINF:5.5,
two.ts
`, "https://media.example.test/vod/index.m3u8");
    expect(parsed).toMatchObject({ classification: "video", encrypted: true, durationSeconds: 10 });
  });

  it("classifies standalone WebVTT and AAC media playlists", () => {
    expect(parseHls("#EXTM3U\n#EXTINF:4,\nsubtitles/one.vtt\n", "https://media.example.test/a.m3u8").classification).toBe("subtitle");
    expect(parseHls("#EXTM3U\n#EXTINF:4,\naudio/one.aac\n", "https://media.example.test/a.m3u8").classification).toBe("audio");
  });

  it("rejects non-HLS input", () => {
    expect(() => parseHls("not a playlist", "https://media.example.test/a.m3u8")).toThrow("not an HLS");
  });

  it("converts a raw network failure into an actionable redacted playlist error", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed for https://secret.example/?token=secret"));
    const candidate = StreamCandidateSchema.parse({
      id: "candidate", tabId: 1, navigationId: "nav", requestId: "request",
      url: "https://media.example.test/master.m3u8?token=secret",
      pageUrl: "https://zerkalo.xyz/item/view/1", pageTitle: "Fixture", observedAt: 1,
      access: { headers: [] }
    });
    await expect(fetchPlaylist(candidate)).rejects.toThrow("authenticated playlist request could not be completed");
    fetch.mockRestore();
  });
});
