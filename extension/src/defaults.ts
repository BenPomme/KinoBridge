export interface MovieDefaults {
  filename: string;
  outputDirectory: string;
  inputStereo?: "half-tb";
  outputProfile?: "xreal-sbs";
  outputWidth?: 3840;
  outputHeight?: 1080;
  aspectCorrection?: 1;
  horizontalAlignment?: 0;
  verticalAlignment?: -78;
  zoom?: 1;
  codec?: "h264-videotoolbox";
}

export function automaticMovieDefaults(title: string): MovieDefaults {
  const base: MovieDefaults = { filename: title.slice(0, 180), outputDirectory: "~/Downloads" };
  if (!/\b3d\b/i.test(title)) return base;
  return {
    ...base,
    inputStereo: "half-tb",
    outputProfile: "xreal-sbs",
    outputWidth: 3840,
    outputHeight: 1080,
    aspectCorrection: 1,
    horizontalAlignment: 0,
    verticalAlignment: -78,
    zoom: 1,
    codec: "h264-videotoolbox"
  };
}
