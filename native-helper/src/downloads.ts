import { randomBytes } from "node:crypto";
import { access, link, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DownloadOptions, MediaTrack, OfflineTrack, StreamDescriptor } from "@kinobridge/shared";
import { sanitizeFilename } from "@kinobridge/shared";
import { requireDependency } from "./diagnostics.js";
import { KinoBridgeError } from "./errors.js";
import { spawnSafe } from "./process.js";
import { buildTopBottomToSbsFilter } from "./stereo.js";

export interface DownloadProgress {
  phase: "downloading" | "validating";
  seconds?: number;
  percent?: number;
}

export interface DownloadResult {
  outputPath: string;
  streams: number;
  durationSeconds?: number;
  tracks: OfflineTrack[];
}

export interface DownloadHandle {
  child: ChildProcessWithoutNullStreams;
  completed: Promise<DownloadResult>;
  cancel(): void;
}

export interface DownloadResources {
  videoUrl: string;
  audio?: { url: string; track: MediaTrack };
  subtitle?: { url: string; track: MediaTrack };
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  duration?: string;
  tags?: { language?: string };
  width?: number;
  height?: number;
}

export interface ProbeMetadata {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string };
}

export interface ValidationExpectations {
  audio: boolean;
  subtitle: boolean;
  durationSeconds?: number;
  audioLanguage?: string;
  subtitleLanguage?: string;
  container?: DownloadOptions["container"];
  videoCodec?: string;
  videoProfile?: string;
  width?: number;
  height?: number;
}

export async function resolveOutputPaths(options: DownloadOptions): Promise<{ temporary: string; final: string }> {
  const directory = resolve(options.outputDirectory.replace(/^~(?=$|\/)/, homedir()));
  const base = sanitizeFilename(options.filename.replace(/\.(?:mkv|mp4)$/i, ""));
  const extension = options.container;
  let final = resolve(directory, `${base}.${extension}`);
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    try {
      await access(final);
      final = resolve(directory, `${base} (${suffix}).${extension}`);
    } catch {
      break;
    }
  }
  if (!final.startsWith(`${directory}${sep}`)) throw new KinoBridgeError("UNSAFE_OUTPUT_PATH", "Output path escapes the selected directory");
  const temporary = resolve(directory, `.${base}.${randomBytes(8).toString("hex")}.part.${extension}`);
  return { temporary, final };
}

async function assertDestinationAvailable(path: string): Promise<void> {
  try {
    await access(path);
    throw new KinoBridgeError("OUTPUT_EXISTS", "Output file already exists");
  } catch (error) {
    if (error instanceof KinoBridgeError) throw error;
  }
}

function safeLanguage(language: string | undefined): string | undefined {
  if (!language || language.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) return undefined;
  return language.toLowerCase();
}

function assertLocalBrokerUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KinoBridgeError("UNSAFE_MEDIA_INPUT", "Download input is not a valid broker URL");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new KinoBridgeError("UNSAFE_MEDIA_INPUT", "FFmpeg inputs must use the loopback access broker");
  }
}

export function buildFfmpegArguments(resources: DownloadResources, descriptor: StreamDescriptor, options: DownloadOptions, temporary: string): string[] {
  assertLocalBrokerUrl(resources.videoUrl);
  if (resources.audio) assertLocalBrokerUrl(resources.audio.url);
  if (resources.subtitle) assertLocalBrokerUrl(resources.subtitle.url);
  const filter = buildTopBottomToSbsFilter(options);
  if (filter && options.codec === "copy") throw new KinoBridgeError("CODEC_REQUIRED", "SBS conversion requires H.264 or HEVC transcoding");
  const videoCodec = options.codec === "copy" ? "copy" : options.codec === "h264-videotoolbox" ? "h264_videotoolbox" : "hevc_videotoolbox";
  const audioInput = resources.audio ? 1 : undefined;
  const subtitleInput = resources.subtitle ? (resources.audio ? 2 : 1) : undefined;
  const audioLanguage = safeLanguage(resources.audio?.track.language);
  const subtitleLanguage = safeLanguage(resources.subtitle?.track.language);
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", resources.videoUrl,
    ...(resources.audio ? ["-i", resources.audio.url] : []),
    ...(options.embedSubtitles && resources.subtitle ? ["-i", resources.subtitle.url] : []),
    // A missing video stream must fail the job; audio is optional only when the
    // descriptor did not offer a separately selectable audio rendition.
    "-map", "0:v:0",
    "-map", audioInput === undefined ? "0:a:0?" : `${audioInput}:a:0`,
    ...(options.embedSubtitles && subtitleInput !== undefined ? ["-map", `${subtitleInput}:s:0`] : []),
    ...(filter ? ["-vf", filter] : []),
    "-c:v", videoCodec,
    ...(options.codec === "copy" ? [] : ["-b:v", options.codec === "hevc-videotoolbox" ? "10M" : "14M"]),
    ...(options.codec === "h264-videotoolbox" ? ["-profile:v", "high"] : []),
    ...(options.codec === "hevc-videotoolbox" ? ["-profile:v", "main"] : []),
    "-c:a", "copy",
    ...(options.embedSubtitles ? ["-c:s", options.container === "mkv" ? "copy" : "mov_text"] : []),
    ...(audioLanguage ? ["-metadata:s:a:0", `language=${audioLanguage}`] : []),
    ...(options.embedSubtitles && subtitleLanguage ? ["-metadata:s:s:0", `language=${subtitleLanguage}`] : []),
    "-progress", "pipe:1",
    "-nostats",
    temporary
  ];
}

function languageMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const normalizedActual = actual.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  return normalizedActual === normalizedExpected
    || normalizedActual.startsWith(`${normalizedExpected}-`)
    || normalizedExpected.startsWith(`${normalizedActual}-`);
}

function normalizedCodec(codec: string): string {
  const normalized = codec.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["avc", "avc1", "h264", "x264"].includes(normalized)) return "h264";
  if (["hevc", "h265", "hev1", "hvc1"].includes(normalized)) return "hevc";
  if (["vp9", "vp09"].includes(normalized)) return "vp9";
  if (["av1", "av01"].includes(normalized)) return "av1";
  return normalized;
}

function expectedSourceVideo(descriptor: StreamDescriptor): { codec?: string; width?: number; height?: number } {
  const selected = [...descriptor.variants].sort((left, right) =>
    (right.height ?? 0) - (left.height ?? 0) || (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
  )[0];
  const codec = selected?.codecs?.split(",").map((value) => value.trim()).find((value) =>
    /^(?:avc|h26[45]|hev1|hvc1|vp0?9|av01)/i.test(value)
  );
  return {
    ...(codec ? { codec: normalizedCodec(codec.split(".", 1)[0]!) } : {}),
    ...(selected?.width ? { width: selected.width } : {}),
    ...(selected?.height ? { height: selected.height } : {})
  };
}

export function buildValidationExpectations(
  resources: DownloadResources,
  descriptor: StreamDescriptor,
  options: DownloadOptions
): ValidationExpectations {
  const source = expectedSourceVideo(descriptor);
  const filter = buildTopBottomToSbsFilter(options);
  const videoCodec = options.codec === "h264-videotoolbox"
    ? "h264"
    : options.codec === "hevc-videotoolbox" ? "hevc" : source.codec;
  const videoProfile = options.codec === "h264-videotoolbox"
    ? "high"
    : options.codec === "hevc-videotoolbox" ? "main" : undefined;
  const audioLanguage = safeLanguage(resources.audio?.track.language);
  const subtitleLanguage = options.embedSubtitles ? safeLanguage(resources.subtitle?.track.language) : undefined;
  return {
    audio: Boolean(resources.audio || descriptor.tracks.some((track) => track.type === "audio") || descriptor.variants.some((variant) => /(?:mp4a|ac-3|ec-3|opus)/i.test(variant.codecs ?? ""))),
    subtitle: Boolean(options.embedSubtitles && resources.subtitle),
    container: options.container,
    ...(descriptor.durationSeconds && descriptor.durationSeconds > 0 ? { durationSeconds: descriptor.durationSeconds } : {}),
    ...(audioLanguage ? { audioLanguage } : {}),
    ...(subtitleLanguage ? { subtitleLanguage } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(videoProfile ? { videoProfile } : {}),
    ...(filter ? { width: options.outputWidth, height: options.outputHeight } : {
      ...(source.width ? { width: source.width } : {}),
      ...(source.height ? { height: source.height } : {})
    })
  };
}

function containerMatches(actual: string | undefined, expected: DownloadOptions["container"]): boolean {
  const names = new Set((actual ?? "").toLowerCase().split(","));
  return expected === "mkv" ? names.has("matroska") : names.has("mp4") || names.has("mov");
}

function profileMatches(actual: string | undefined, expected: string): boolean {
  return (actual ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") === expected.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function validateProbeMetadata(path: string, parsed: ProbeMetadata, expected: ValidationExpectations): DownloadResult {
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
  if (videoStreams.length < 1) throw new KinoBridgeError("VALIDATION_FAILED", "Completed file contains no video stream");
  if (expected.container && !containerMatches(parsed.format?.format_name, expected.container)) {
    throw new KinoBridgeError("VALIDATION_FAILED", "Completed file container does not match the requested output");
  }
  const video = videoStreams[0]!;
  if (expected.videoCodec && (!video.codec_name || normalizedCodec(video.codec_name) !== normalizedCodec(expected.videoCodec))) {
    throw new KinoBridgeError("VALIDATION_FAILED", "Completed file video codec does not match the requested output");
  }
  if (expected.videoProfile && !profileMatches(video.profile, expected.videoProfile)) {
    throw new KinoBridgeError("VALIDATION_FAILED", "Completed file video profile does not match the requested output");
  }
  if ((expected.width && video.width !== expected.width) || (expected.height && video.height !== expected.height)) {
    throw new KinoBridgeError("VALIDATION_FAILED", "Completed file video geometry does not match the requested output");
  }
  if (expected.audio && audioStreams.length < 1) throw new KinoBridgeError("VALIDATION_FAILED", "Completed file is missing the selected audio track");
  if (expected.subtitle && subtitleStreams.length < 1) throw new KinoBridgeError("VALIDATION_FAILED", "Completed file is missing the selected subtitle track");
  if (expected.audioLanguage && !audioStreams.some((stream) => languageMatches(stream.tags?.language, expected.audioLanguage))) {
    throw new KinoBridgeError("VALIDATION_FAILED", "Completed file does not contain the selected audio language");
  }
  if (expected.subtitleLanguage && !subtitleStreams.some((stream) => languageMatches(stream.tags?.language, expected.subtitleLanguage))) {
    throw new KinoBridgeError("VALIDATION_FAILED", "Completed file does not contain the selected subtitle language");
  }
  const duration = Number(parsed.format?.duration);
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : undefined;
  if (expected.durationSeconds !== undefined && expected.durationSeconds > 0) {
    if (validDuration === undefined) throw new KinoBridgeError("VALIDATION_FAILED", "Completed file has no valid duration");
    const tolerance = Math.max(5, Math.min(30, expected.durationSeconds * 0.01));
    if (Math.abs(validDuration - expected.durationSeconds) > tolerance) {
      throw new KinoBridgeError("VALIDATION_FAILED", "Completed file duration differs from the source");
    }
  }
  const tracks: OfflineTrack[] = streams.flatMap((stream) => {
    if (stream.codec_type !== "video" && stream.codec_type !== "audio" && stream.codec_type !== "subtitle") return [];
    return [{
      type: stream.codec_type,
      ...(stream.codec_name ? { codec: stream.codec_name } : {}),
      ...(stream.tags?.language ? { language: stream.tags.language } : {}),
      ...(stream.width && stream.width > 0 ? { width: stream.width } : {}),
      ...(stream.height && stream.height > 0 ? { height: stream.height } : {})
    }];
  });
  return { outputPath: path, streams: streams.length, tracks, ...(validDuration === undefined ? {} : { durationSeconds: validDuration }) };
}

export function decodeSampleOffsets(durationSeconds: number | undefined): number[] {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 8) return [0];
  return [0, Math.max(0, durationSeconds - 5)];
}

export function buildDecodeSampleArguments(path: string, offsetSeconds: number): string[] {
  return [
    "-v", "error",
    "-nostdin",
    "-xerror",
    ...(offsetSeconds > 0 ? ["-ss", offsetSeconds.toFixed(3)] : []),
    "-i", path,
    "-t", "2",
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-f", "null",
    "-"
  ];
}

async function waitForProcess(child: ChildProcessWithoutNullStreams, timeoutMs = 60_000): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function validateOutput(path: string, expected: ValidationExpectations): Promise<DownloadResult> {
  const ffprobe = await requireDependency("ffprobe");
  const child = spawnSafe(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,profile,duration,width,height:stream_tags=language",
    "-of", "json",
    path
  ]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length + chunk.length > 1024 * 1024) child.kill("SIGKILL");
    else stdout += chunk.toString("utf8");
  });
  child.stderr.resume();
  const exitCode = await waitForProcess(child, 30_000);
  if (exitCode !== 0) throw new KinoBridgeError("VALIDATION_FAILED", "ffprobe rejected the completed file");
  let parsed: ProbeMetadata;
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new KinoBridgeError("VALIDATION_FAILED", "ffprobe returned malformed metadata");
  }
  const result = validateProbeMetadata(path, parsed, expected);
  const ffmpeg = await requireDependency("ffmpeg");
  for (const offset of decodeSampleOffsets(result.durationSeconds)) {
    const decoder = spawnSafe(ffmpeg, buildDecodeSampleArguments(path, offset));
    decoder.stdout.resume();
    let decoderError = "";
    decoder.stderr.on("data", (chunk: Buffer) => {
      if (decoderError.length + chunk.length <= 16_384) decoderError += chunk.toString("utf8");
    });
    if (await waitForProcess(decoder) !== 0) {
      throw new KinoBridgeError("VALIDATION_FAILED", `Completed file failed a decode sample${decoderError ? ": " + decoderError.slice(0, 256).trim() : ""}`);
    }
  }
  return result;
}

export async function startDownload(
  resources: DownloadResources,
  descriptor: StreamDescriptor,
  options: DownloadOptions,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadHandle> {
  const ffmpeg = await requireDependency("ffmpeg");
  const paths = await resolveOutputPaths(options);
  await assertDestinationAvailable(paths.final);
  const child = spawnSafe(ffmpeg, buildFfmpegArguments(resources, descriptor, options, paths.temporary));
  let progressBuffer = "";
  let canceled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    progressBuffer += chunk.toString("utf8");
    const records = progressBuffer.split(/\r?\n/);
    progressBuffer = records.pop() ?? "";
    for (const record of records) {
      const match = record.match(/^out_time_(?:us|ms)=(\d+)$/);
      if (!match?.[1]) continue;
      const seconds = Number(match[1]) / 1_000_000;
      const percent = descriptor.durationSeconds && descriptor.durationSeconds > 0 ? Math.min(100, seconds / descriptor.durationSeconds * 100) : undefined;
      onProgress({ phase: "downloading", seconds, ...(percent === undefined ? {} : { percent }) });
    }
  });
  child.stderr.resume();
  const completed = (async (): Promise<DownloadResult> => {
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (canceled) throw new KinoBridgeError("CANCELED", "Download was canceled");
      if (code !== 0) throw new KinoBridgeError("FFMPEG_FAILED", `FFmpeg exited with code ${code ?? "unknown"}`, true);
      onProgress({ phase: "validating" });
      const validated = await validateOutput(paths.temporary, buildValidationExpectations(resources, descriptor, options));
      try {
        await link(paths.temporary, paths.final);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new KinoBridgeError("OUTPUT_EXISTS", "Output file was created by another process");
        throw error;
      }
      await rm(paths.temporary, { force: true });
      return { ...validated, outputPath: paths.final };
    } catch (error) {
      await rm(paths.temporary, { force: true });
      throw error;
    }
  })();
  return {
    child,
    completed,
    cancel: () => {
      canceled = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5_000).unref();
    }
  };
}
