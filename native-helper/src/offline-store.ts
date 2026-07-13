import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import {
  DownloadOptionsSchema,
  OfflineLibraryEntrySchema as LibraryEntrySchema,
  OfflineQueueItemSchema as QueueItemSchema,
  OfflineSnapshotSchema,
  OfflineSourceSchema as SafeSourceSchema,
  type DownloadOptions,
  type OfflineJobState,
  type OfflineLibraryEntry,
  type OfflineQueueItem,
  type OfflineSnapshot,
  type OfflineSource as SafeSource,
  type OfflineTrack
} from "@kinobridge/shared";
import { KinoBridgeError } from "./errors.js";

export type { OfflineJobState, OfflineLibraryEntry, OfflineQueueItem, OfflineSnapshot, OfflineTrack, SafeSource };

function defaultStatePath(): string {
  return join(homedir(), "Library", "Application Support", "KinoBridge", "offline-state.json");
}

function safeSource(source: SafeSource): SafeSource {
  const parsed = SafeSourceSchema.parse(source);
  const url = new URL(parsed.pageUrl);
  const host = url.hostname.toLowerCase();
  const kinoHost = host === "kino.pub" || host.endsWith(".kino.pub") || host === "zerkalo.xyz" || host.endsWith(".zerkalo.xyz");
  if (url.protocol !== "https:" || !kinoHost || url.username || url.password || url.search || url.hash) {
    throw new KinoBridgeError("UNSAFE_OFFLINE_SOURCE", "Offline source identity must be a credential-free Kino page URL");
  }
  return { title: parsed.title, pageUrl: url.toString() };
}

export class OfflineStore {
  private state: { version: 1; queue: OfflineQueueItem[]; library: OfflineLibraryEntry[] } = { version: 1, queue: [], library: [] };
  private loaded = false;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly statePath = defaultStatePath()) {}

  async load(): Promise<OfflineSnapshot> {
    if (this.loaded) return this.snapshot();
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as { version?: unknown; queue?: unknown; library?: unknown };
      const parsed = OfflineSnapshotSchema.safeParse({ queue: raw.queue, library: raw.library });
      if (!parsed.success) throw new KinoBridgeError("OFFLINE_STATE_INVALID", "Offline state file is invalid");
      this.state = { version: 1, ...parsed.data };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { await rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`); } catch { /* Keep the helper available if quarantine itself fails. */ }
        this.state = { version: 1, queue: [], library: [] };
      }
    }
    this.loaded = true;
    let changed = false;
    this.state.queue = this.state.queue.map((item) => {
      if (item.state !== "running" && item.state !== "queued") return item;
      changed = true;
      return { ...item, state: "interrupted", updatedAt: Date.now(), error: "Fresh authorized stream access is required to restart this download" };
    });
    if (changed) await this.persist();
    return this.snapshot();
  }

  snapshot(): OfflineSnapshot {
    return structuredClone({ queue: this.state.queue, library: this.state.library });
  }

  async enqueue(id: string, source: SafeSource, options: DownloadOptions, quality = "auto"): Promise<OfflineQueueItem> {
    return this.mutate(() => {
      if (this.state.queue.some((item) => item.id === id)) throw new KinoBridgeError("DUPLICATE_JOB", "Offline job already exists");
      const now = Date.now();
      const item = QueueItemSchema.parse({ id, source: safeSource(source), options: DownloadOptionsSchema.parse(options), quality, state: "queued", createdAt: now, updatedAt: now });
      this.state.queue.push(item);
      return item;
    });
  }

  async updateJob(id: string, patch: Partial<Pick<OfflineQueueItem, "state" | "progress" | "error" | "outputPath">>): Promise<OfflineQueueItem> {
    return this.mutate(() => {
      const index = this.state.queue.findIndex((item) => item.id === id);
      if (index < 0) throw new KinoBridgeError("JOB_NOT_FOUND", "Offline job was not found");
      const current = this.state.queue[index]!;
      const next = QueueItemSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
      this.state.queue[index] = next;
      return next;
    });
  }

  async retry(id: string): Promise<OfflineQueueItem> {
    const item = this.state.queue.find((candidate) => candidate.id === id);
    if (!item || !["interrupted", "failed", "canceled"].includes(item.state)) {
      throw new KinoBridgeError("JOB_NOT_RETRYABLE", "Offline job is not waiting for a restart");
    }
    return this.updateJob(id, { state: "queued", error: undefined, progress: undefined, outputPath: undefined });
  }

  async removeJob(id: string): Promise<void> {
    await this.mutate(() => {
      const item = this.state.queue.find((candidate) => candidate.id === id);
      if (item?.state === "running") throw new KinoBridgeError("JOB_RUNNING", "Cancel the download before removing it");
      this.state.queue = this.state.queue.filter((candidate) => candidate.id !== id);
    });
  }

  getJob(id: string): OfflineQueueItem | undefined {
    const item = this.state.queue.find((candidate) => candidate.id === id);
    return item ? structuredClone(item) : undefined;
  }

  nextQueued(): OfflineQueueItem | undefined {
    const item = this.state.queue.find((candidate) => candidate.state === "queued");
    return item ? structuredClone(item) : undefined;
  }

  async addLibraryEntry(entry: OfflineLibraryEntry): Promise<OfflineLibraryEntry> {
    return this.mutate(() => {
      const parsed = LibraryEntrySchema.parse({ ...entry, outputPath: resolve(entry.outputPath), sourcePageUrl: safeSource({ title: entry.title, pageUrl: entry.sourcePageUrl }).pageUrl });
      this.state.library = [parsed, ...this.state.library.filter((candidate) => candidate.id !== parsed.id && candidate.outputPath !== parsed.outputPath)];
      return parsed;
    });
  }

  getLibraryEntry(id: string): OfflineLibraryEntry | undefined {
    const entry = this.state.library.find((candidate) => candidate.id === id);
    return entry ? structuredClone(entry) : undefined;
  }

  async removeLibraryEntry(id: string): Promise<void> {
    await this.mutate(() => { this.state.library = this.state.library.filter((candidate) => candidate.id !== id); });
  }

  async deleteLibraryFile(id: string): Promise<void> {
    const entry = this.getLibraryEntry(id);
    if (!entry) throw new KinoBridgeError("LIBRARY_NOT_FOUND", "Offline title was not found");
    const extension = extname(entry.outputPath).toLowerCase();
    if (extension !== ".mkv" && extension !== ".mp4") throw new KinoBridgeError("UNSAFE_LIBRARY_PATH", "Only registered MKV or MP4 files can be deleted");
    try {
      const metadata = await lstat(entry.outputPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new KinoBridgeError("UNSAFE_LIBRARY_PATH", "Offline library path is not a regular media file");
      await rm(entry.outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.removeLibraryEntry(id);
  }

  private async mutate<T>(change: () => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.mutation.then(async () => {
      if (!this.loaded) await this.load();
      result = await change();
      await this.persist();
    });
    this.mutation = operation.catch(() => undefined);
    await operation;
    return structuredClone(result);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}
