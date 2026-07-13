import { describe, expect, it } from "vitest";
import { parseHls } from "../src/hls.js";

describe("HLS parsing", () => {
  it("classifies a master and resolves variants and tracks", () => {
    const parsed = parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",LANGUAGE="fr",DEFAULT=YES,URI="audio/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="../subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=23.976
video/main.m3u8
`, "https://media.example.test/show/master.m3u8?token=secret");
    expect(parsed.classification).toBe("master");
    expect(parsed.variants[0]).toMatchObject({ uri: "https://media.example.test/show/video/main.m3u8", width: 1920, height: 1080 });
    expect(parsed.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "audio", language: "fr", default: true, uri: "https://media.example.test/show/audio/fr.m3u8" }),
      expect.objectContaining({ type: "subtitle", language: "en", uri: "https://media.example.test/subs/en.m3u8" })
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
});
