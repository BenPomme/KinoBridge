import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadOptionsSchema, StreamDescriptorSchema } from "@kinobridge/shared";
import {
  buildDecodeSampleArguments,
  buildFfmpegArguments,
  buildValidationExpectations,
  decodeSampleOffsets,
  resolveOutputPaths,
  validateProbeMetadata
} from "../src/downloads.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function descriptor() {
  return StreamDescriptorSchema.parse({
    source: "kino.pub",
    candidate: {
      id: "candidate",
      tabId: 1,
      navigationId: "nav",
      requestId: "request",
      url: "https://cdn.example/master.m3u8?token=secret",
      pageUrl: "https://kino.pub/item/1",
      pageTitle: "Fixture",
      observedAt: 1,
      access: { headers: [] }
    },
    classification: "master",
    durationSeconds: 7_200,
    variants: [{ uri: "https://cdn.example/video.m3u8?token=video-secret", width: 1920, height: 1080, codecs: "avc1.640028" }],
    tracks: [
      { id: "audio-en", type: "audio", uri: "https://cdn.example/audio.m3u8?token=audio-secret", language: "en" },
      { id: "sub-fr", type: "subtitle", uri: "https://cdn.example/subtitles.m3u8?token=subtitle-secret", language: "fr" }
    ]
  });
}

function localResources() {
  const parsed = descriptor();
  return {
    videoUrl: "http://127.0.0.1:49152/capability/video.m3u8",
    audio: { url: "http://127.0.0.1:49152/capability/audio.m3u8", track: parsed.tracks[0]! },
    subtitle: { url: "http://127.0.0.1:49152/capability/subtitles.m3u8", track: parsed.tracks[1]! }
  };
}

describe("download planning", () => {
  it("uses collision-safe sanitized filenames inside the selected directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kinobridge-download-test-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "Season 1-Episode 1.mkv"), "existing");
    const options = DownloadOptionsSchema.parse({ outputDirectory: directory, filename: "../Season 1:Episode 1", container: "mkv" });
    const paths = await resolveOutputPaths(options);
    expect(paths.final).toBe(join(directory, "Season 1-Episode 1 (2).mkv"));
    expect(paths.temporary.startsWith(`${directory}/.`)).toBe(true);
  });

  it("keeps the signed upstream URL out of the FFmpeg argument array", () => {
    const options = DownloadOptionsSchema.parse({ outputDirectory: "/tmp", filename: "Fixture", container: "mkv", codec: "copy" });
    const args = buildFfmpegArguments(localResources(), descriptor(), options, "/tmp/.Fixture.part.mkv");
    expect(args).toContain("http://127.0.0.1:49152/capability/video.m3u8");
    expect(args.join(" ")).not.toContain("secret");
    expect(args).toContain("copy");
  });

  it("rejects direct upstream URLs before constructing FFmpeg arguments", () => {
    const resources = localResources();
    resources.videoUrl = "https://cdn.example/video.m3u8?token=secret";
    const options = DownloadOptionsSchema.parse({ outputDirectory: "/tmp", filename: "Fixture" });
    expect(() => buildFfmpegArguments(resources, descriptor(), options, "/tmp/.Fixture.part.mkv")).toThrow(/loopback access broker/i);
  });

  it("maps exactly the selected video, audio, and embedded subtitle inputs", () => {
    const options = DownloadOptionsSchema.parse({
      outputDirectory: "/tmp",
      filename: "Fixture",
      container: "mkv",
      codec: "copy",
      audioLanguages: ["en"],
      subtitleLanguages: ["fr"]
    });
    const args = buildFfmpegArguments(localResources(), descriptor(), options, "/tmp/.Fixture.part.mkv");
    const inputs = args.flatMap((arg, index) => arg === "-i" ? [args[index + 1]] : []);
    const maps = args.flatMap((arg, index) => arg === "-map" ? [args[index + 1]] : []);
    expect(inputs).toEqual([
      "http://127.0.0.1:49152/capability/video.m3u8",
      "http://127.0.0.1:49152/capability/audio.m3u8",
      "http://127.0.0.1:49152/capability/subtitles.m3u8"
    ]);
    expect(maps).toEqual(["0:v:0", "1:a:0", "2:s:0"]);
    expect(args).toContain("language=en");
    expect(args).toContain("language=fr");
  });

  it("does not open or map a subtitle input when embedding is disabled", () => {
    const options = DownloadOptionsSchema.parse({ outputDirectory: "/tmp", filename: "Fixture", embedSubtitles: false });
    const args = buildFfmpegArguments(localResources(), descriptor(), options, "/tmp/.Fixture.part.mkv");
    expect(args).not.toContain(localResources().subtitle.url);
    expect(args).not.toContain("2:s:0");
  });

  it("requires transcoding for SBS output", () => {
    const options = DownloadOptionsSchema.parse({
      outputDirectory: "/tmp",
      filename: "Fixture",
      codec: "copy",
      inputStereo: "half-tb",
      outputProfile: "xreal-sbs"
    });
    expect(() => buildFfmpegArguments({ videoUrl: "http://127.0.0.1:49152/stream" }, descriptor(), options, "/tmp/output.mkv")).toThrow(/requires H\.264 or HEVC/i);
  });

  it("pins the codec profile for VideoToolbox SBS output", () => {
    const options = DownloadOptionsSchema.parse({
      outputDirectory: "/tmp",
      filename: "Fixture",
      codec: "h264-videotoolbox",
      inputStereo: "half-tb",
      outputProfile: "xreal-sbs",
      outputWidth: 3840,
      outputHeight: 1080
    });
    const args = buildFfmpegArguments(localResources(), descriptor(), options, "/tmp/output.mkv");
    expect(args).toContain("h264_videotoolbox");
    expect(args.slice(args.indexOf("-profile:v"), args.indexOf("-profile:v") + 2)).toEqual(["-profile:v", "high"]);
    expect(buildValidationExpectations(localResources(), descriptor(), options)).toMatchObject({
      container: "mkv",
      videoCodec: "h264",
      videoProfile: "high",
      width: 3840,
      height: 1080
    });
  });
});

describe("completed download validation", () => {
  const completeProbe = {
    streams: [
      { codec_type: "video", codec_name: "h264", profile: "High", width: 1920, height: 1080 },
      { codec_type: "audio", codec_name: "aac", tags: { language: "en" } },
      { codec_type: "subtitle", codec_name: "webvtt", tags: { language: "fr" } }
    ],
    format: { duration: "7201.25", format_name: "matroska,webm" }
  };

  it("accepts video plus the selected tracks within duration tolerance", () => {
    expect(validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true,
      subtitle: true,
      durationSeconds: 7_200,
      audioLanguage: "en",
      subtitleLanguage: "fr"
    })).toMatchObject({
      outputPath: "/tmp/movie.mkv",
      streams: 3,
      durationSeconds: 7201.25,
      tracks: [
        { type: "video", codec: "h264" },
        { type: "audio", codec: "aac", language: "en" },
        { type: "subtitle", codec: "webvtt", language: "fr" }
      ]
    });
  });

  it("rejects output without video even when it contains audio", () => {
    expect(() => validateProbeMetadata("/tmp/movie.mkv", {
      streams: [{ codec_type: "audio" }], format: { duration: "7200" }
    }, { audio: true, subtitle: false })).toThrow(/no video stream/i);
  });

  it("rejects missing selected audio, subtitle, or language", () => {
    expect(() => validateProbeMetadata("/tmp/movie.mkv", {
      streams: [{ codec_type: "video" }], format: { duration: "7200" }
    }, { audio: true, subtitle: false })).toThrow(/selected audio/i);
    expect(() => validateProbeMetadata("/tmp/movie.mkv", {
      streams: [{ codec_type: "video" }, { codec_type: "audio", tags: { language: "en" } }], format: { duration: "7200" }
    }, { audio: true, subtitle: true })).toThrow(/selected subtitle/i);
    expect(() => validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true, subtitle: true, audioLanguage: "de"
    })).toThrow(/audio language/i);
  });

  it("rejects truncated output outside the bounded duration tolerance", () => {
    expect(() => validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true, subtitle: true, durationSeconds: 7_000
    })).toThrow(/duration differs/i);
  });

  it("rejects the wrong container, codec, profile, or geometry", () => {
    expect(() => validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true, subtitle: true, container: "mp4"
    })).toThrow(/container/i);
    expect(() => validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true, subtitle: true, videoCodec: "hevc"
    })).toThrow(/codec/i);
    expect(() => validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true, subtitle: true, videoProfile: "main"
    })).toThrow(/profile/i);
    expect(() => validateProbeMetadata("/tmp/movie.mkv", completeProbe, {
      audio: true, subtitle: true, width: 3840, height: 1080
    })).toThrow(/geometry/i);
  });

  it("validates remux container, source codec, and source geometry when advertised", () => {
    const expected = buildValidationExpectations(localResources(), descriptor(), DownloadOptionsSchema.parse({
      outputDirectory: "/tmp", filename: "Fixture", container: "mkv", codec: "copy"
    }));
    expect(expected).toMatchObject({ container: "mkv", videoCodec: "h264", width: 1920, height: 1080 });
    expect(validateProbeMetadata("/tmp/movie.mkv", completeProbe, expected).streams).toBe(3);
  });

  it("plans beginning and ending decode samples with mandatory video", () => {
    expect(decodeSampleOffsets(7_200)).toEqual([0, 7_195]);
    expect(decodeSampleOffsets(4)).toEqual([0]);
    const args = buildDecodeSampleArguments("/tmp/movie.mkv", 7_195);
    expect(args).toContain("-xerror");
    expect(args).toContain("7195.000");
    expect(args).toContain("0:v:0");
    expect(args).toContain("0:a:0?");
  });
});
