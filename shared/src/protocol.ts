import { z } from "zod";

// Chrome MV3 forbids dynamic code evaluation. Keep Zod's object parser in its
// CSP-safe interpreter mode in both the extension and native helper.
z.config({ jitless: true });

export const PROTOCOL_VERSION = 1 as const;

export const PlayerSchema = z.enum(["mpv", "iina", "vlc"]);
export const StereoFormatSchema = z.enum([
  "auto",
  "2d",
  "half-tb",
  "full-tb",
  "half-sbs",
  "full-sbs",
  "unknown"
]);
export const EyeOrderSchema = z.enum(["left-first", "right-first"]);
export const OutputProfileSchema = z.enum(["normal", "xreal-sbs"]);
export const ContainerSchema = z.enum(["mkv", "mp4"]);
export const CodecSchema = z.enum(["copy", "h264-videotoolbox", "hevc-videotoolbox"]);

export const HeaderSchema = z.object({
  name: z.string().min(1).max(128),
  value: z.string().max(8192)
});

export const AccessContextSchema = z.object({
  referer: z.string().url().optional(),
  userAgent: z.string().max(1024).optional(),
  cookie: z.string().max(65536).optional(),
  headers: z.array(HeaderSchema).max(16).default([])
});

export const StreamCandidateSchema = z.object({
  id: z.string().min(1),
  tabId: z.number().int().nonnegative(),
  navigationId: z.string().min(1),
  requestId: z.string().min(1),
  url: z.string().url(),
  initiator: z.string().optional(),
  pageUrl: z.string().url(),
  pageTitle: z.string().max(512).default("Kino.pub stream"),
  observedAt: z.number().int().nonnegative(),
  access: AccessContextSchema.default({ headers: [] })
});

export const VariantSchema = z.object({
  uri: z.string(),
  bandwidth: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  codecs: z.string().optional(),
  frameRate: z.number().positive().optional()
});

export const MediaTrackSchema = z.object({
  id: z.string(),
  type: z.enum(["audio", "subtitle"]),
  uri: z.string().optional(),
  language: z.string().optional(),
  name: z.string().optional(),
  codec: z.string().optional(),
  groupId: z.string().optional(),
  default: z.boolean().default(false),
  forced: z.boolean().default(false)
});

export const StreamDescriptorSchema = z.object({
  source: z.literal("kino.pub"),
  candidate: StreamCandidateSchema,
  classification: z.enum(["master", "video", "audio", "subtitle", "unknown"]),
  masterUrl: z.string().url().optional(),
  variants: z.array(VariantSchema).default([]),
  tracks: z.array(MediaTrackSchema).default([]),
  stereo: StereoFormatSchema.default("unknown"),
  encrypted: z.boolean().default(false),
  durationSeconds: z.number().nonnegative().optional()
});

export const PlaybackOptionsSchema = z.object({
  player: PlayerSchema.default("mpv"),
  audioLanguages: z.array(z.string()).default(["fr", "en"]),
  subtitleLanguages: z.array(z.string()).default(["fr", "en"]),
  subtitlesEnabled: z.boolean().default(true),
  forcedSubtitlesOnly: z.boolean().default(false),
  inputStereo: StereoFormatSchema.default("auto"),
  eyeOrder: EyeOrderSchema.default("left-first"),
  outputProfile: OutputProfileSchema.default("normal"),
  outputWidth: z.number().int().min(640).max(7680).default(3840),
  outputHeight: z.number().int().min(360).max(4320).default(1080),
  aspectCorrection: z.number().min(0.25).max(4).default(1),
  horizontalAlignment: z.number().int().min(-500).max(500).default(0),
  verticalAlignment: z.number().int().min(-500).max(500).default(0),
  zoom: z.number().min(0.25).max(4).default(1),
  refreshRate: z.number().int().min(24).max(120).default(60)
});

export const DownloadOptionsSchema = z.object({
  ...PlaybackOptionsSchema.shape,
  outputDirectory: z.string().min(1),
  filename: z.string().min(1).max(240),
  container: ContainerSchema.default("mkv"),
  codec: CodecSchema.default("copy"),
  embedSubtitles: z.boolean().default(true)
});

export const OfflineJobStateSchema = z.enum(["queued", "running", "interrupted", "completed", "failed", "canceled"]);
export const OfflineSourceSchema = z.object({
  title: z.string().min(1).max(512),
  pageUrl: z.string().url()
}).strict();
export const OfflineQueueItemSchema = z.object({
  id: z.string().min(1).max(128),
  source: OfflineSourceSchema,
  options: DownloadOptionsSchema,
  quality: z.string().regex(/^(?:auto|\d{3,4}p?)$/).default("auto"),
  state: OfflineJobStateSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  progress: z.object({ percent: z.number().min(0).max(100).optional(), seconds: z.number().nonnegative().optional() }).strict().optional(),
  error: z.string().max(500).optional(),
  outputPath: z.string().min(1).optional()
}).strict();
export const OfflineTrackSchema = z.object({
  type: z.enum(["video", "audio", "subtitle"]),
  codec: z.string().max(128).optional(),
  language: z.string().max(64).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
}).strict();
export const OfflineLibraryEntrySchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(512),
  sourcePageUrl: z.string().url(),
  outputPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().optional(),
  tracks: z.array(OfflineTrackSchema).max(128),
  createdAt: z.number().int().nonnegative()
}).strict();
export const OfflineSnapshotSchema = z.object({
  queue: z.array(OfflineQueueItemSchema).max(1_000),
  library: z.array(OfflineLibraryEntrySchema).max(10_000)
}).strict();

export const CommandTypeSchema = z.enum([
  "hello",
  "probe",
  "play",
  "download",
  "cancel",
  "status",
  "refreshResponse",
  "offlineRetry",
  "offlineRemove",
  "libraryPlay",
  "libraryReveal",
  "libraryDelete"
]);
export const EventTypeSchema = z.enum([
  "ready",
  "probeResult",
  "progress",
  "completed",
  "failed",
  "refreshRequired",
  "offlineState"
]);

export const EnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  type: z.union([CommandTypeSchema, EventTypeSchema]),
  payload: z.unknown()
});

export type Player = z.infer<typeof PlayerSchema>;
export type StereoFormat = z.infer<typeof StereoFormatSchema>;
export type EyeOrder = z.infer<typeof EyeOrderSchema>;
export type AccessContext = z.infer<typeof AccessContextSchema>;
export type StreamCandidate = z.infer<typeof StreamCandidateSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type MediaTrack = z.infer<typeof MediaTrackSchema>;
export type StreamDescriptor = z.infer<typeof StreamDescriptorSchema>;
export type PlaybackOptions = z.infer<typeof PlaybackOptionsSchema>;
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>;
export type OfflineJobState = z.infer<typeof OfflineJobStateSchema>;
export type OfflineSource = z.infer<typeof OfflineSourceSchema>;
export type OfflineQueueItem = z.infer<typeof OfflineQueueItemSchema>;
export type OfflineTrack = z.infer<typeof OfflineTrackSchema>;
export type OfflineLibraryEntry = z.infer<typeof OfflineLibraryEntrySchema>;
export type OfflineSnapshot = z.infer<typeof OfflineSnapshotSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function makeEnvelope(type: Envelope["type"], payload: unknown, id = crypto.randomUUID()): Envelope {
  return { version: PROTOCOL_VERSION, id, type, payload };
}
