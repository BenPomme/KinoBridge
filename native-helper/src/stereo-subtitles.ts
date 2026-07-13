import { KinoBridgeError } from "./errors.js";

const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
const STYLE_FORMAT = "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";

function splitAssEvent(line: string): string[] | undefined {
  if (!/^Dialogue\s*:/i.test(line)) return undefined;
  const fields: string[] = [];
  let remainder = line.slice(line.indexOf(":") + 1).trimStart();
  for (let index = 0; index < 9; index += 1) {
    const comma = remainder.indexOf(",");
    if (comma < 0) return undefined;
    fields.push(remainder.slice(0, comma));
    remainder = remainder.slice(comma + 1);
  }
  fields.push(remainder);
  return fields;
}

function safeDialogueText(text: string): string {
  // Subtitle input is untrusted. Remove source ASS overrides so it cannot
  // escape the per-eye clipping region or replace the controlled styling.
  return text.replace(/\{[^}]*\}/g, "").replace(/[{}]/g, "");
}

export function buildStereoAss(source: string, outputWidth: number, outputHeight: number): string {
  if (!Number.isInteger(outputWidth) || outputWidth < 640 || outputWidth > 7680 || outputWidth % 2 !== 0) {
    throw new KinoBridgeError("INVALID_STEREO_OPTION", "Stereo subtitle width must be an even display width");
  }
  if (!Number.isInteger(outputHeight) || outputHeight < 360 || outputHeight > 4320) {
    throw new KinoBridgeError("INVALID_STEREO_OPTION", "Stereo subtitle height is invalid");
  }
  if (source.length > 16 * 1024 * 1024) {
    throw new KinoBridgeError("SUBTITLE_TOO_LARGE", "Subtitle track is too large to prepare safely");
  }

  const halfWidth = outputWidth / 2;
  const sideMargin = Math.max(32, Math.round(halfWidth * 0.0625));
  const verticalMargin = Math.max(32, Math.round(outputHeight * 0.065));
  const fontSize = Math.max(24, Math.round(outputHeight * 0.045));
  const outline = Math.max(2, Math.round(outputHeight / 360));
  const leftRightMargin = halfWidth + sideMargin;
  const leftStyle = `Style: LeftEye,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${sideMargin},${leftRightMargin},${verticalMargin},1`;
  const rightStyle = `Style: RightEye,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${leftRightMargin},${sideMargin},${verticalMargin},1`;
  const events: string[] = [];

  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const fields = splitAssEvent(line);
    if (!fields) continue;
    const text = safeDialogueText(fields[9] ?? "");
    for (const [style, clipLeft, clipRight] of [
      ["LeftEye", 0, halfWidth],
      ["RightEye", halfWidth, outputWidth]
    ] as const) {
      const copy = [...fields];
      copy[3] = style;
      copy[5] = "0";
      copy[6] = "0";
      copy[7] = "0";
      copy[9] = `{\\clip(${clipLeft},0,${clipRight},${outputHeight})}${text}`;
      events.push(`Dialogue: ${copy.join(",")}`);
    }
  }
  if (events.length === 0) {
    throw new KinoBridgeError("SUBTITLE_PREPARATION_FAILED", "The selected subtitle track contains no readable cues");
  }

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${outputWidth}`,
    `PlayResY: ${outputHeight}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    STYLE_FORMAT,
    leftStyle,
    rightStyle,
    "",
    "[Events]",
    EVENT_FORMAT,
    ...events,
    ""
  ].join("\n");
}
