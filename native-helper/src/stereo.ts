import type { PlaybackOptions } from "@kinobridge/shared";
import { KinoBridgeError } from "./errors.js";
import type { CropRegion, StereoAnalysis } from "./stereo-analysis.js";

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new KinoBridgeError("INVALID_STEREO_OPTION", `${name} must be finite`);
  return value;
}

function normalizedCrop(region: CropRegion | undefined, bottom: boolean): { y: string; height: string } {
  if (!region) return { y: bottom ? "ih/2" : "0", height: "ih/2" };
  const yRatio = region.y / 160;
  const heightRatio = region.height / 160;
  const localY = `trunc((ih/2)*${yRatio.toFixed(8)}/2)*2`;
  return {
    y: bottom ? `ih/2+${localY}` : localY,
    height: `trunc((ih/2)*${heightRatio.toFixed(8)}/2)*2`
  };
}

function eyeChain(
  label: string,
  crop: { y: string; height: string },
  options: PlaybackOptions,
  horizontalSign: 1 | -1,
  verticalSign: 1 | -1
): string {
  const eyeWidth = Math.floor(options.outputWidth / 2);
  const zoom = finite(options.zoom, "zoom");
  const aspect = finite(options.aspectCorrection, "aspect correction");
  const horizontal = options.horizontalAlignment * horizontalSign;
  const vertical = options.verticalAlignment * verticalSign;
  const horizontalTravel = Math.abs(options.horizontalAlignment) * 2;
  const verticalTravel = Math.abs(options.verticalAlignment) * 2;
  const x = `max(0\\,min(iw-ow\\,(iw-ow)/2+${horizontal}))`;
  const y = `max(0\\,min(ih-oh\\,(ih-oh)/2+${vertical}))`;
  const verticalRestore = options.inputStereo === "full-tb" ? 1 : 2;
  const restore = verticalRestore * aspect;
  const fitWidth = `trunc(min(${eyeWidth}\\,${options.outputHeight}*dar/${restore})/2)*2`;
  const fitHeight = `trunc(min(${options.outputHeight}\\,${eyeWidth}*${restore}/dar)/2)*2`;
  return `crop=iw:${crop.height}:0:${crop.y},scale=${fitWidth}:${fitHeight}:reset_sar=1:flags=lanczos,scale=iw*${zoom}:ih*${zoom},pad=max(iw\\,${eyeWidth})+${horizontalTravel}:max(ih\\,${options.outputHeight})+${verticalTravel}:(ow-iw)/2:(oh-ih)/2:black,crop=${eyeWidth}:${options.outputHeight}:${x}:${y}[${label}]`;
}

export function buildTopBottomToSbsFilter(options: PlaybackOptions, geometry?: StereoAnalysis): string | undefined {
  const convert = options.outputProfile === "xreal-sbs" || options.inputStereo === "half-tb" || options.inputStereo === "full-tb";
  if (!convert) return undefined;
  if (options.outputWidth % 2 !== 0) throw new KinoBridgeError("INVALID_STEREO_OPTION", "SBS output width must be even");
  if (options.inputStereo !== "auto" && options.inputStereo !== "half-tb" && options.inputStereo !== "full-tb") {
    throw new KinoBridgeError("UNSUPPORTED_STEREO_INPUT", "Only Top/Bottom input can be converted to SBS");
  }
  const topLabel = options.eyeOrder === "left-first" ? "left" : "right";
  const bottomLabel = options.eyeOrder === "left-first" ? "right" : "left";
  return [
    `split=2[top][bottom]`,
    `[top]${eyeChain(topLabel, normalizedCrop(geometry?.top, false), options, 1, 1)}`,
    `[bottom]${eyeChain(bottomLabel, normalizedCrop(geometry?.bottom, true), options, -1, -1)}`,
    `[left][right]hstack=inputs=2,setsar=1`
  ].join(";");
}
