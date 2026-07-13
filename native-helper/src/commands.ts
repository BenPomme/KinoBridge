import { z } from "zod";
import {
  DownloadOptionsSchema,
  PlayerSchema,
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
export const OfflineRetryPayloadSchema = z.object({ jobId: z.string().min(1).max(128), descriptor: StreamDescriptorSchema }).strict();
export const OfflineRemovePayloadSchema = z.object({ jobId: z.string().min(1).max(128) }).strict();
export const LibraryPlayPayloadSchema = z.object({ libraryId: z.string().min(1).max(128), player: PlayerSchema }).strict();
export const LibraryEntryPayloadSchema = z.object({ libraryId: z.string().min(1).max(128) }).strict();
