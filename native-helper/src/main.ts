#!/usr/bin/env node
import { EnvelopeSchema, PROTOCOL_VERSION } from "@kinobridge/shared";
import {
  CancelPayloadSchema,
  DownloadPayloadSchema,
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

function send(type: "ready" | "probeResult" | "progress" | "completed" | "failed" | "refreshRequired", payload: unknown, id?: string): void {
  process.stdout.write(encodeNativeMessage({ version: PROTOCOL_VERSION, id: id ?? crypto.randomUUID(), type, payload }));
}

const jobs = new JobManager((type, payload) => send(type, payload));

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
        const dependencies = await diagnoseDependencies();
        send("ready", { helperVersion: "0.1.0", protocolVersion: envelope.version, dependencies }, envelope.id);
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
        const job = await jobs.startDownload(envelope.id, descriptor, options);
        send("progress", { jobId: job.id, phase: "started", job }, envelope.id);
        return;
      }
      case "cancel": {
        const { jobId } = CancelPayloadSchema.parse(envelope.payload);
        send("completed", { jobId, job: jobs.cancel(jobId), canceled: true }, envelope.id);
        return;
      }
      case "status": {
        const { jobId } = StatusPayloadSchema.parse(envelope.payload);
        send("progress", { jobs: jobs.status(jobId) }, envelope.id);
        return;
      }
      case "refreshResponse": {
        const { jobId, candidate } = RefreshPayloadSchema.parse(envelope.payload);
        send("progress", { jobId, phase: "refreshed", job: jobs.refresh(jobId, candidate) }, envelope.id);
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

process.on("uncaughtException", (error) => {
  log("error", "Uncaught helper error", { error: error.message });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  log("error", "Unhandled helper rejection", { error: error instanceof Error ? error.message : "unknown" });
  process.exit(1);
});
