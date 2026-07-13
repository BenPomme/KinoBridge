import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { KinoBridgeError } from "./errors.js";
import { spawnSafe } from "./process.js";

const ANALYSIS_WIDTH = 320;
const ANALYSIS_EYE_HEIGHT = 160;

export interface CropRegion {
  y: number;
  height: number;
}

export interface StereoCropSample {
  top: CropRegion;
  bottom: CropRegion;
}

export interface StereoAnalysis {
  verticalAlignment: number;
  samples: number;
  topCenter: number;
  bottomCenter: number;
  top: CropRegion;
  bottom: CropRegion;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function validRegion(region: CropRegion): boolean {
  return Number.isInteger(region.y)
    && Number.isInteger(region.height)
    && region.y >= 0
    && region.height >= ANALYSIS_EYE_HEIGHT * 0.25
    && region.y + region.height <= ANALYSIS_EYE_HEIGHT;
}

function consensusEdge(values: number[]): number {
  const center = median(values);
  const tolerance = Math.max(2, ANALYSIS_EYE_HEIGHT * 0.01);
  const support = values.filter((value) => Math.abs(value - center) <= tolerance).length / values.length;
  const required = values.length >= 5 ? 0.8 : 2 / 3;
  return support >= required ? Math.max(0, Math.round(center)) : 0;
}

export function parseStereoCropLog(stderr: string): StereoCropSample | undefined {
  const latest: Partial<StereoCropSample> = {};
  const expression = /\[cropdetect@(top|bottom)[^\]]*\][^\n]*?crop=\d+:(\d+):\d+:(\d+)/g;
  for (const match of stderr.matchAll(expression)) {
    const eye = match[1] as "top" | "bottom";
    const height = Number(match[2]);
    const y = Number(match[3]);
    latest[eye] = { y, height };
  }
  if (!latest.top || !latest.bottom || !validRegion(latest.top) || !validRegion(latest.bottom)) return undefined;
  return { top: latest.top, bottom: latest.bottom };
}

export function deriveStereoAnalysis(samples: StereoCropSample[], outputHeight: number): StereoAnalysis {
  const valid = samples.filter((sample) => validRegion(sample.top) && validRegion(sample.bottom));
  if (valid.length === 0) {
    throw new KinoBridgeError("STEREO_ANALYSIS_FAILED", "KinoBridge could not measure both 3D eye images");
  }
  const topTop = consensusEdge(valid.map(({ top }) => top.y));
  const topBottom = consensusEdge(valid.map(({ top }) => ANALYSIS_EYE_HEIGHT - top.y - top.height));
  const bottomTop = consensusEdge(valid.map(({ bottom }) => bottom.y));
  const bottomBottom = consensusEdge(valid.map(({ bottom }) => ANALYSIS_EYE_HEIGHT - bottom.y - bottom.height));
  const topCenter = (topTop + ANALYSIS_EYE_HEIGHT - topBottom - 1) / 2;
  const bottomCenter = (bottomTop + ANALYSIS_EYE_HEIGHT - bottomBottom - 1) / 2;
  const topHeight = median(valid.map(({ top }) => top.height));
  const bottomHeight = median(valid.map(({ bottom }) => bottom.height));
  if (Math.abs(topHeight - bottomHeight) > Math.max(6, Math.max(topHeight, bottomHeight) * 0.15)) {
    throw new KinoBridgeError("STEREO_GEOMETRY_AMBIGUOUS", "The two 3D eye images have incompatible active geometry");
  }
  const verticalAlignment = Math.round((topCenter - bottomCenter) * outputHeight / (2 * ANALYSIS_EYE_HEIGHT));
  if (Math.abs(verticalAlignment) > outputHeight / 3) {
    throw new KinoBridgeError("STEREO_GEOMETRY_AMBIGUOUS", "The detected 3D eye offset is outside the safe range");
  }
  const detectedTopHeight = ANALYSIS_EYE_HEIGHT - topTop - topBottom;
  const detectedBottomHeight = ANALYSIS_EYE_HEIGHT - bottomTop - bottomBottom;
  const commonHeight = Math.min(ANALYSIS_EYE_HEIGHT, Math.max(detectedTopHeight, detectedBottomHeight));
  const regionAround = (center: number): CropRegion => ({
    y: Math.max(0, Math.min(ANALYSIS_EYE_HEIGHT - commonHeight, Math.round(center - (commonHeight - 1) / 2))),
    height: commonHeight
  });
  return {
    verticalAlignment,
    samples: valid.length,
    topCenter,
    bottomCenter,
    top: regionAround(topCenter),
    bottom: regionAround(bottomCenter)
  };
}

export function stereoSampleOffsets(durationSeconds: number | undefined): number[] {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds < 18) return [0];
  const offsets = durationSeconds < 120
    ? [durationSeconds * 0.1, durationSeconds * 0.3, durationSeconds * 0.5, durationSeconds * 0.7, durationSeconds * 0.9]
    : [Math.min(60, durationSeconds * 0.1), durationSeconds * 0.28, durationSeconds * 0.5, durationSeconds * 0.72, Math.max(0, durationSeconds - 120)];
  return [...new Set(offsets.map((offset) => Math.max(0, Math.round(offset * 1000) / 1000)))];
}

function assertLocalBrokerUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KinoBridgeError("UNSAFE_MEDIA_INPUT", "Stereo analysis requires a valid broker URL");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new KinoBridgeError("UNSAFE_MEDIA_INPUT", "Stereo analysis is limited to the loopback access broker");
  }
}

function waitForAnalysis(child: ChildProcessWithoutNullStreams, signal: AbortSignal | undefined, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let abortKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();
    const abort = (): void => {
      child.kill("SIGTERM");
      abortKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 750);
      abortKill.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (abortKill) clearTimeout(abortKill);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (abortKill) clearTimeout(abortKill);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new KinoBridgeError("CANCELED", "Download was canceled"));
      else if (timedOut) reject(new KinoBridgeError("STEREO_ANALYSIS_FAILED", "3D geometry analysis timed out"));
      else resolve(code);
    });
  });
}

async function inspectOffset(
  ffmpeg: string,
  localUrl: string,
  offset: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<StereoCropSample | undefined> {
  if (signal?.aborted) throw new KinoBridgeError("CANCELED", "Download was canceled");
  const graph = [
    "[0:v:0]fps=2,split=2[top][bottom]",
    `[top]crop=iw:ih/2:0:0,scale=${ANALYSIS_WIDTH}:${ANALYSIS_EYE_HEIGHT}:flags=area,cropdetect@top=limit=0.08:round=2:skip=0:reset=0[topout]`,
    `[bottom]crop=iw:ih/2:0:ih/2,scale=${ANALYSIS_WIDTH}:${ANALYSIS_EYE_HEIGHT}:flags=area,cropdetect@bottom=limit=0.08:round=2:skip=0:reset=0[bottomout]`
  ].join(";");
  const child = spawnSafe(ffmpeg, [
    "-hide_banner",
    "-nostdin",
    ...(offset > 0 ? ["-ss", offset.toFixed(3)] : []),
    "-i", localUrl,
    "-filter_complex", graph,
    "-map", "[topout]", "-t", "3", "-an", "-f", "null", "-",
    "-map", "[bottomout]", "-t", "3", "-an", "-f", "null", "-"
  ]);
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length + chunk.length <= 256 * 1024) stderr += chunk.toString("utf8");
    else child.kill("SIGKILL");
  });
  const code = await waitForAnalysis(child, signal, timeoutMs);
  const parsed = parseStereoCropLog(stderr);
  if (parsed) return parsed;
  if (code !== 0) return undefined;
  return undefined;
}

export async function analyzeTopBottomGeometry(
  ffmpeg: string,
  localUrl: string,
  durationSeconds: number | undefined,
  outputHeight: number,
  signal?: AbortSignal
): Promise<StereoAnalysis> {
  assertLocalBrokerUrl(localUrl);
  const offsets = stereoSampleOffsets(durationSeconds);
  const samples: StereoCropSample[] = [];
  const deadline = Date.now() + 45_000;
  for (const offset of offsets) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const sample = await inspectOffset(ffmpeg, localUrl, offset, Math.min(12_000, remaining), signal);
      if (sample) samples.push(sample);
    } catch (error) {
      if (error instanceof KinoBridgeError && error.code === "CANCELED") throw error;
    }
  }
  const required = offsets.length > 1 ? 3 : 1;
  if (samples.length < required) {
    throw new KinoBridgeError("STEREO_ANALYSIS_FAILED", "KinoBridge could not reliably inspect this movie's 3D eye geometry");
  }
  return deriveStereoAnalysis(samples, outputHeight);
}
