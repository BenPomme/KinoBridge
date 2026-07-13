import { z } from "zod";
import {
  DownloadOptionsSchema,
  PlaybackOptionsSchema,
  StreamCandidateSchema,
  StreamDescriptorSchema
} from "@kinobridge/shared";

export const ProbePayloadSchema = z.object({ candidate: StreamCandidateSchema }).strict();
export const PlayPayloadSchema = z.object({ descriptor: StreamDescriptorSchema, options: PlaybackOptionsSchema }).strict();
export const DownloadPayloadSchema = z.object({ descriptor: StreamDescriptorSchema, options: DownloadOptionsSchema }).strict();
export const CancelPayloadSchema = z.object({ jobId: z.string().min(1).max(128) }).strict();
export const StatusPayloadSchema = z.object({ jobId: z.string().min(1).max(128).optional() }).strict();
export const RefreshPayloadSchema = z.object({ jobId: z.string().min(1).max(128), candidate: StreamCandidateSchema }).strict();
