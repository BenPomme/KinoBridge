import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadOptionsSchema, StreamCandidateSchema, StreamDescriptorSchema } from "@kinobridge/shared";
import { AccessBroker } from "../src/broker.js";
import { startDownload } from "../src/downloads.js";

const run = promisify(execFile);
const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!ffmpeg)("offline media pipeline integration", () => {
  it("downloads separate video, selected audio, and subtitle HLS into a validated offline MKV", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-offline-pipeline-"));
    roots.push(root);
    await run(ffmpeg!, [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
      "-hls_segment_filename", join(root, "video-%d.ts"), join(root, "video.m3u8")
    ]);
    await run(ffmpeg!, [
      "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "4",
      "-c:a", "aac", "-vn", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
      "-hls_segment_filename", join(root, "audio-%d.ts"), join(root, "audio.m3u8")
    ]);
    await writeFile(join(root, "subtitle.m3u8"), "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.000,\nsubtitle-0.vtt\n#EXT-X-ENDLIST\n");
    await writeFile(join(root, "subtitle-0.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:03.500\nOffline subtitle fixture\n");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const name = basename(url.pathname);
      try {
        const body = await readFile(join(root, name));
        const contentType = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl"
          : name.endsWith(".vtt") ? "text/vtt" : "video/mp2t";
        return new Response(body, { status: 200, headers: { "content-type": contentType, "content-length": String(body.length) } });
      } catch {
        return new Response("missing", { status: 404 });
      }
    });

    const candidate = StreamCandidateSchema.parse({
      id: "integration", tabId: 1, navigationId: "nav", requestId: "request",
      url: "https://media.example.test/video.m3u8", pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1",
      pageTitle: "Offline integration", observedAt: Date.now(), access: { headers: [] }
    });
    const descriptor = StreamDescriptorSchema.parse({
      source: "kino.pub", candidate, classification: "video", durationSeconds: 4,
      tracks: [
        { id: "audio-en", type: "audio", uri: "https://media.example.test/audio.m3u8", language: "en" },
        { id: "subtitle-en", type: "subtitle", uri: "https://media.example.test/subtitle.m3u8", language: "en" }
      ]
    });
    const broker = new AccessBroker(candidate, undefined, descriptor.tracks.flatMap((track) => track.uri ? [track.uri] : []));
    try {
      const videoUrl = await broker.start(candidate.url);
      const result = await (await startDownload({
        videoUrl,
        audio: { url: broker.expose(descriptor.tracks[0]!.uri!), track: descriptor.tracks[0]! },
        subtitle: { url: broker.expose(descriptor.tracks[1]!.uri!), track: descriptor.tracks[1]! }
      }, descriptor, DownloadOptionsSchema.parse({
        outputDirectory: root, filename: "Offline Integration", container: "mkv", codec: "copy",
        audioLanguages: ["en"], subtitleLanguages: ["en"], embedSubtitles: true
      }), () => undefined)).completed;
      expect(result.durationSeconds).toBeGreaterThan(3.5);
      expect(result.tracks).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "video" }),
        expect.objectContaining({ type: "audio", language: "en" }),
        expect.objectContaining({ type: "subtitle", language: "en" })
      ]));
      expect(await readFile(result.outputPath)).not.toHaveLength(0);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it.skipIf(process.platform !== "darwin")("transcodes SBS video and embeds a dual-eye ASS subtitle track", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-stereo-pipeline-"));
    roots.push(root);
    await run(ffmpeg!, [
      "-v", "error", "-f", "lavfi",
      "-i", "color=c=black:s=320x200,drawbox=x=0:y=0:w=320:h=80:color=red:t=fill,drawbox=x=0:y=120:w=320:h=80:color=blue:t=fill",
      "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
      "-hls_segment_filename", join(root, "stereo-video-%d.ts"), join(root, "stereo-video.m3u8")
    ]);
    await writeFile(join(root, "stereo-subtitle.m3u8"), "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.000,\nstereo-subtitle-0.vtt\n#EXT-X-ENDLIST\n");
    await writeFile(join(root, "stereo-subtitle-0.vtt"), "WEBVTT\n\n00:00:00.500 --> 00:00:03.500\nReadable in both eyes\n");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const name = basename(url.pathname);
      try {
        const body = await readFile(join(root, name));
        const contentType = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl"
          : name.endsWith(".vtt") ? "text/vtt" : "video/mp2t";
        return new Response(body, { status: 200, headers: { "content-type": contentType, "content-length": String(body.length) } });
      } catch {
        return new Response("missing", { status: 404 });
      }
    });

    const candidate = StreamCandidateSchema.parse({
      id: "stereo-integration", tabId: 1, navigationId: "nav", requestId: "request",
      url: "https://media.example.test/stereo-video.m3u8", pageUrl: "https://zerkalo.xyz/item/view/3d",
      pageTitle: "Stereo Integration 3D", observedAt: Date.now(), access: { headers: [] }
    });
    const descriptor = StreamDescriptorSchema.parse({
      source: "kino.pub", candidate, classification: "video", durationSeconds: 4,
      variants: [{ uri: candidate.url, width: 320, height: 200, codecs: "avc1.64001f" }],
      tracks: [{ id: "subtitle-en", type: "subtitle", uri: "https://media.example.test/stereo-subtitle.m3u8", language: "en" }]
    });
    const broker = new AccessBroker(candidate, undefined, descriptor.tracks.flatMap((track) => track.uri ? [track.uri] : []));
    try {
      const videoUrl = await broker.start(candidate.url);
      const result = await (await startDownload({
        videoUrl,
        subtitle: { url: broker.expose(descriptor.tracks[0]!.uri!), track: descriptor.tracks[0]! }
      }, descriptor, DownloadOptionsSchema.parse({
        outputDirectory: root, filename: "Stereo Integration", container: "mkv", codec: "h264-videotoolbox",
        inputStereo: "half-tb", outputProfile: "xreal-sbs", outputWidth: 640, outputHeight: 360,
        verticalAlignment: -36, subtitleLanguages: ["en"], embedSubtitles: true
      }), () => undefined)).completed;
      expect(result.tracks).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "video", codec: "h264", width: 640, height: 360 }),
        expect.objectContaining({ type: "subtitle", codec: "ass", language: "en" })
      ]));
      expect((await readdir(root)).filter((name) => name.includes(".source.ass") || name.includes(".stereo.ass"))).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);
});
