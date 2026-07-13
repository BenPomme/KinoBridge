#!/usr/bin/env node
import { EnvelopeSchema, PROTOCOL_VERSION } from "@kinobridge/shared";
import {
  CancelPayloadSchema,
  DownloadPayloadSchema,
  LibraryEntryPayloadSchema,
  LibraryPlayPayloadSchema,
  OfflineRemovePayloadSchema,
  OfflineRetryPayloadSchema,
  PlayPayloadSchema,
  ProbePayloadSchema,
  RefreshPayloadSchema,
  StatusPayloadSchema
} from "./commands.js";
import { diagnoseDependencies } from "./diagnostics.js";
import { safeError } from "./errors.js";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.js";
import { probeCandidate } from "./hls.js";
import { JobManager } from "./jobs.js";
import { log } from "./log.js";
import { playOffline, revealOffline } from "./offline-library.js";
import { OfflineManager } from "./offline-manager.js";
import { OfflineStore } from "./offline-store.js";

function send(type: "ready" | "probeResult" | "progress" | "completed" | "failed" | "refreshRequired" | "offlineState", payload: unknown, id?: string): void {
  process.stdout.write(encodeNativeMessage({ version: PROTOCOL_VERSION, id: id ?? crypto.randomUUID(), type, payload }));
}

const jobs = new JobManager((type, payload) => send(type, payload));
const offlineStore = new OfflineStore();
const offline = new OfflineManager(offlineStore, (type, payload, id) => send(type, payload, id));

async function handle(raw: unknown): Promise<void> {
  const envelopeResult = EnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) {
    send("failed", { error: { code: "INVALID_ENVELOPE", message: "Message envelope is invalid", retryable: false } });
    return;
  }
  const envelope = envelopeResult.data;
  try {
    switch (envelope.type) {
      case "hello": {
        const [dependencies, offlineSnapshot] = await Promise.all([diagnoseDependencies(), offline.initialize()]);
        send("ready", { helperVersion: "0.1.0", protocolVersion: envelope.version, dependencies, offline: offlineSnapshot }, envelope.id);
        return;
      }
      case "probe": {
        const { candidate } = ProbePayloadSchema.parse(envelope.payload);
        const descriptor = await probeCandidate(candidate);
        send("probeResult", { descriptor }, envelope.id);
        return;
      }
      case "play": {
        const { descriptor, options } = PlayPayloadSchema.parse(envelope.payload);
        const job = await jobs.startPlayback(envelope.id, descriptor, options);
        send("progress", { jobId: job.id, phase: "started", job }, envelope.id);
        return;
      }
      case "download": {
        const { descriptor, options } = DownloadPayloadSchema.parse(envelope.payload);
        const snapshot = await offline.enqueue(envelope.id, descriptor, options);
        send("offlineState", snapshot, envelope.id);
        return;
      }
      case "cancel": {
        const { jobId } = CancelPayloadSchema.parse(envelope.payload);
        if (offline.has(jobId)) send("offlineState", await offline.cancel(jobId), envelope.id);
        else send("completed", { jobId, job: jobs.cancel(jobId), canceled: true }, envelope.id);
        return;
      }
      case "status": {
        const { jobId } = StatusPayloadSchema.parse(envelope.payload);
        if (jobId && offline.has(jobId)) send("offlineState", offline.snapshot(), envelope.id);
        else send("progress", { jobs: jobs.status(jobId), offline: offline.snapshot() }, envelope.id);
        return;
      }
      case "refreshResponse": {
        const { jobId, candidate } = RefreshPayloadSchema.parse(envelope.payload);
        if (offline.has(jobId)) send("offlineState", offline.refresh(jobId, candidate), envelope.id);
        else send("progress", { jobId, phase: "refreshed", job: jobs.refresh(jobId, candidate) }, envelope.id);
        return;
      }
      case "offlineRetry": {
        const { jobId, descriptor } = OfflineRetryPayloadSchema.parse(envelope.payload);
        send("offlineState", await offline.retry(jobId, descriptor), envelope.id);
        return;
      }
      case "offlineRemove": {
        const { jobId } = OfflineRemovePayloadSchema.parse(envelope.payload);
        send("offlineState", await offline.remove(jobId), envelope.id);
        return;
      }
      case "libraryPlay": {
        const { libraryId, player } = LibraryPlayPayloadSchema.parse(envelope.payload);
        await playOffline(offlineStore, libraryId, player);
        send("offlineState", offline.snapshot(), envelope.id);
        return;
      }
      case "libraryReveal": {
        const { libraryId } = LibraryEntryPayloadSchema.parse(envelope.payload);
        await revealOffline(offlineStore, libraryId);
        send("offlineState", offline.snapshot(), envelope.id);
        return;
      }
      case "libraryDelete": {
        const { libraryId } = LibraryEntryPayloadSchema.parse(envelope.payload);
        await offlineStore.deleteLibraryFile(libraryId);
        send("offlineState", offline.snapshot(), envelope.id);
        return;
      }
      default:
        send("failed", { error: { code: "UNSUPPORTED_COMMAND", message: "Message type is not a helper command", retryable: false } }, envelope.id);
    }
  } catch (error) {
    send("failed", { error: safeError(error) }, envelope.id);
  }
}

const decoder = new NativeMessageDecoder();
decoder.on("data", (message: unknown) => { void handle(message); });
decoder.once("error", (error) => {
  log("error", "Native Messaging input failed", { error: error instanceof Error ? error.message : "unknown" });
  process.exitCode = 1;
});
process.stdin.pipe(decoder);
process.stdin.once("end", () => { void offline.interruptActive(); });

process.on("uncaughtException", (error) => {
  log("error", "Uncaught helper error", { error: error.message });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  log("error", "Unhandled helper rejection", { error: error instanceof Error ? error.message : "unknown" });
  process.exit(1);
});
