import { randomBytes } from "node:crypto";
import { access, link, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DownloadOptions, StreamDescriptor } from "@kinobridge/shared";
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
}

export interface DownloadHandle {
  child: ChildProcessWithoutNullStreams;
  completed: Promise<DownloadResult>;
  cancel(): void;
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

export function buildFfmpegArguments(localUrl: string, descriptor: StreamDescriptor, options: DownloadOptions, temporary: string): string[] {
  const filter = buildTopBottomToSbsFilter(options);
  if (filter && options.codec === "copy") throw new KinoBridgeError("CODEC_REQUIRED", "SBS conversion requires H.264 or HEVC transcoding");
  const videoCodec = options.codec === "copy" ? "copy" : options.codec === "h264-videotoolbox" ? "h264_videotoolbox" : "hevc_videotoolbox";
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", localUrl,
    "-map", "0:v:0?",
    "-map", "0:a?",
    ...(options.embedSubtitles ? ["-map", "0:s?"] : []),
    ...(filter ? ["-vf", filter] : []),
    "-c:v", videoCodec,
    ...(options.codec === "copy" ? [] : ["-b:v", options.codec === "hevc-videotoolbox" ? "10M" : "14M"]),
    "-c:a", "copy",
    ...(options.embedSubtitles ? ["-c:s", options.container === "mkv" ? "copy" : "mov_text"] : []),
    "-progress", "pipe:1",
    "-nostats",
    temporary
  ];
}

async function validateOutput(path: string): Promise<DownloadResult> {
  const ffprobe = await requireDependency("ffprobe");
  const child = spawnSafe(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type", "-of", "json", path]);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length + chunk.length > 1024 * 1024) child.kill("SIGKILL");
    else stdout += chunk.toString("utf8");
  });
  child.stderr.resume();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new KinoBridgeError("VALIDATION_FAILED", "ffprobe rejected the completed file");
  let parsed: { streams?: unknown[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new KinoBridgeError("VALIDATION_FAILED", "ffprobe returned malformed metadata");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams.length : 0;
  if (streams < 1) throw new KinoBridgeError("VALIDATION_FAILED", "Completed file contains no media streams");
  const duration = Number(parsed.format?.duration);
  return { outputPath: path, streams, ...(Number.isFinite(duration) && duration >= 0 ? { durationSeconds: duration } : {}) };
}

export async function startDownload(
  localUrl: string,
  descriptor: StreamDescriptor,
  options: DownloadOptions,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadHandle> {
  const ffmpeg = await requireDependency("ffmpeg");
  const paths = await resolveOutputPaths(options);
  await assertDestinationAvailable(paths.final);
  const child = spawnSafe(ffmpeg, buildFfmpegArguments(localUrl, descriptor, options, paths.temporary));
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
      const validated = await validateOutput(paths.temporary);
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
