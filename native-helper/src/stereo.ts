import type { PlaybackOptions } from "@kinobridge/shared";
import { KinoBridgeError } from "./errors.js";

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new KinoBridgeError("INVALID_STEREO_OPTION", `${name} must be finite`);
  return value;
}

function eyeChain(label: string, cropY: string, options: PlaybackOptions, horizontalSign: 1 | -1, verticalSign: 1 | -1): string {
  const eyeWidth = Math.floor(options.outputWidth / 2);
  const zoom = finite(options.zoom, "zoom");
  const aspect = finite(options.aspectCorrection, "aspect correction");
  const scaledWidth = Math.max(1, Math.round(eyeWidth * zoom));
  const scaledHeight = Math.max(1, Math.round(options.outputHeight * zoom * aspect));
  const horizontal = options.horizontalAlignment * horizontalSign;
  const vertical = options.verticalAlignment * verticalSign;
  const horizontalTravel = Math.abs(options.horizontalAlignment) * 2;
  const verticalTravel = Math.abs(options.verticalAlignment) * 2;
  const x = `max(0\\,min(iw-ow\\,(iw-ow)/2+${horizontal}))`;
  const y = `max(0\\,min(ih-oh\\,(ih-oh)/2+${vertical}))`;
  return `crop=iw:ih/2:0:${cropY},scale=${scaledWidth}:${scaledHeight},pad=max(iw\\,${eyeWidth})+${horizontalTravel}:max(ih\\,${options.outputHeight})+${verticalTravel}:(ow-iw)/2:(oh-ih)/2:black,crop=${eyeWidth}:${options.outputHeight}:${x}:${y}[${label}]`;
}

export function buildTopBottomToSbsFilter(options: PlaybackOptions): string | undefined {
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
    `[top]${eyeChain(topLabel, "0", options, 1, 1)}`,
    `[bottom]${eyeChain(bottomLabel, "ih/2", options, -1, -1)}`,
    `[left][right]hstack=inputs=2,setsar=1`
  ].join(";");
}
