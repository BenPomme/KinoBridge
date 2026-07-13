import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import type { StreamCandidate } from "@kinobridge/shared";
import { assertSafeUpstream } from "@kinobridge/shared";
import { KinoBridgeError } from "./errors.js";
import { requestHeaders } from "./hls.js";
import { log } from "./log.js";
import { safeError } from "./errors.js";

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_BROKER_RESOURCES = 50_000;
const MAX_BROKER_ORIGINS = 64;
const MAX_REFRESH_LINEAGE_DEPTH = 16;
const AUTH_REFRESH_TIMEOUT_MS = 60_000;
const FORWARDED_RESPONSE_HEADERS = new Set(["content-type", "accept-ranges", "content-range", "cache-control", "last-modified", "etag"]);

interface BrokerResource {
  url: URL;
  identity: string;
  parentId?: string;
  slot?: string;
  urlGeneration: number;
  manifestGeneration: number;
}

interface RefreshWaiter {
  generation: number;
  resolve: (generation: number) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function allowedUpstream(raw: string, origins: ReadonlySet<string>): URL {
  try {
    return assertSafeUpstream(raw, origins);
  } catch {
    throw new KinoBridgeError("UNSAFE_UPSTREAM", "Upstream URL is outside the broker's HTTPS origin");
  }
}

function isManifest(url: URL, contentType: string): boolean {
  return /(?:mpegurl|m3u8)/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(url.pathname + url.search);
}

// Signed query parameters are deliberately excluded. The path is the stable
// identity used to reconnect an existing localhost capability to a refreshed
// playlist reference without exposing either URL to the player.
function resourceIdentity(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MANIFEST_BYTES) throw new KinoBridgeError("MANIFEST_TOO_LARGE", "Playlist exceeds 5 MiB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new KinoBridgeError("MANIFEST_TOO_LARGE", "Playlist exceeds 5 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export class AccessBroker {
  private readonly token = randomBytes(32).toString("hex");
  private readonly resources = new Map<string, BrokerResource>();
  private readonly childSlots = new Map<string, string>();
  private readonly allowedOrigins: Set<string>;
  private readonly refreshWaiters = new Set<RefreshWaiter>();
  private server: Server | undefined;
  private port: number | undefined;
  private candidateRootId: string | undefined;
  private refreshGeneration = 0;
  private refreshRequestedGeneration: number | undefined;
  private diagnosticRequestCount = 0;

  constructor(
    private candidate: StreamCandidate,
    private readonly onAuthExpired?: () => void,
    additionalPlaylistUrls: readonly string[] = []
  ) {
    const root = new URL(candidate.url);
    if (root.protocol !== "https:" || root.username || root.password) throw new KinoBridgeError("UNSAFE_UPSTREAM", "Candidate must be a credential-free HTTPS URL");
    const origins = new Set([root.origin]);
    for (const raw of additionalPlaylistUrls) {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new KinoBridgeError("UNSAFE_UPSTREAM", "Master playlist references must be credential-free HTTPS URLs");
      }
      origins.add(url.origin);
    }
    this.allowedOrigins = origins;
  }

  async start(entryUrl = this.candidate.url): Promise<string> {
    if (this.server) throw new KinoBridgeError("BROKER_ALREADY_STARTED", "Broker has already started");
    this.candidateRootId = this.register(this.candidate.url);
    const entryId = this.register(entryUrl);
    this.server = createServer((request, response) => {
      void this.handle(request.method ?? "GET", request.url ?? "", request.headers.range, response).catch((error) => {
        const sanitized = safeError(error);
        log("warn", "Broker request failed", { code: sanitized.code, message: sanitized.message, retryable: sanitized.retryable });
        if (!response.headersSent) response.writeHead(error instanceof KinoBridgeError ? 400 : 502, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("KinoBridge broker request failed");
      });
    });
    this.server.maxHeadersCount = 32;
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new KinoBridgeError("BROKER_BIND_FAILED", "Broker did not bind to loopback");
    this.port = address.port;
    return this.localUrl(entryId);
  }

  expose(upstreamUrl: string): string {
    if (!this.server) throw new KinoBridgeError("BROKER_NOT_STARTED", "Broker is not running");
    return this.localUrl(this.register(upstreamUrl));
  }

  async close(): Promise<void> {
    const closedError = new KinoBridgeError("BROKER_CLOSED", "Broker closed while authorization refresh was pending", true);
    for (const waiter of this.refreshWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(closedError);
    }
    this.refreshWaiters.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.resources.clear();
    this.childSlots.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  refresh(candidate: StreamCandidate): void {
    const next = allowedUpstream(candidate.url, this.allowedOrigins);
    this.candidate = candidate;
    this.refreshGeneration += 1;
    this.refreshRequestedGeneration = undefined;
    if (this.candidateRootId) {
      const root = this.resources.get(this.candidateRootId);
      if (root) {
        root.url = next;
        root.identity = resourceIdentity(next);
        root.urlGeneration = this.refreshGeneration;
      }
    }
    for (const waiter of [...this.refreshWaiters]) {
      if (waiter.generation >= this.refreshGeneration) continue;
      clearTimeout(waiter.timeout);
      this.refreshWaiters.delete(waiter);
      waiter.resolve(this.refreshGeneration);
    }
  }

  private localUrl(id: string): string {
    if (!this.port) throw new KinoBridgeError("BROKER_NOT_STARTED", "Broker is not running");
    const upstream = this.resources.get(id)?.url;
    const extension = upstream?.pathname.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
    const safeExtension = extension && /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ".bin";
    return `http://127.0.0.1:${this.port}/${this.token}/${id}${safeExtension}`;
  }

  private register(raw: string, base?: URL): string {
    const upstream = allowedUpstream(new URL(raw, base).toString(), this.allowedOrigins);
    for (const [existingId, existing] of this.resources) {
      if (!existing.parentId && existing.url.toString() === upstream.toString()) return existingId;
    }
    if (this.resources.size >= MAX_BROKER_RESOURCES) throw new KinoBridgeError("BROKER_RESOURCE_LIMIT", "Broker resource limit was reached");
    const id = randomBytes(16).toString("hex");
    this.resources.set(id, {
      url: upstream,
      identity: resourceIdentity(upstream),
      urlGeneration: this.refreshGeneration,
      manifestGeneration: -1
    });
    return id;
  }

  private registerManifestReference(raw: string, base: URL, parentId: string, slot: string, generation: number): string {
    const referenced = new URL(raw, base);
    const hostname = referenced.hostname.replace(/^\[|\]$/g, "");
    if (referenced.protocol !== "https:" || referenced.username || referenced.password) {
      throw new KinoBridgeError("UNSAFE_UPSTREAM", "Playlist references must be credential-free HTTPS URLs");
    }
    if (hostname === "localhost" || hostname.endsWith(".local") || isIP(hostname) !== 0) {
      throw new KinoBridgeError("UNSAFE_UPSTREAM", "Playlist references may not target local hosts or IP literals");
    }
    if (!this.allowedOrigins.has(referenced.origin)) {
      if (this.allowedOrigins.size >= MAX_BROKER_ORIGINS) throw new KinoBridgeError("BROKER_ORIGIN_LIMIT", "Broker origin limit was reached");
      this.allowedOrigins.add(referenced.origin);
    }
    const upstream = allowedUpstream(referenced.toString(), this.allowedOrigins);
    const slotKey = `${parentId}:${slot}`;
    const existingChildId = this.childSlots.get(slotKey);
    if (existingChildId) {
      const existingChild = this.resources.get(existingChildId);
      if (existingChild) {
        existingChild.url = upstream;
        existingChild.identity = resourceIdentity(upstream);
        existingChild.urlGeneration = generation;
        return existingChildId;
      }
      this.childSlots.delete(slotKey);
    }

    // A refreshed playlist may rotate CDN hosts while retaining its media
    // paths. Reconnect only when the path identifies exactly one existing
    // child of this parent; ambiguity is rejected rather than guessed.
    const samePathChildren = [...this.resources.entries()].filter(([, resource]) =>
      resource.parentId === parentId && resource.url.pathname === upstream.pathname
    );
    if (samePathChildren.length === 1) {
      const [id, resource] = samePathChildren[0]!;
      if (resource.slot) this.childSlots.delete(`${parentId}:${resource.slot}`);
      resource.url = upstream;
      resource.identity = resourceIdentity(upstream);
      resource.slot = slot;
      resource.urlGeneration = generation;
      this.childSlots.set(slotKey, id);
      return id;
    }

    // Playback can expose a selected variant/audio/subtitle before its master
    // is requested. Adopt that detached capability when the refreshed master
    // later reveals the same stable resource path.
    const identity = resourceIdentity(upstream);
    let detached = [...this.resources.entries()].find(([id, resource]) =>
      id !== this.candidateRootId && !resource.parentId && resource.identity === identity
    );
    if (!detached) {
      const samePathDetached = [...this.resources.entries()].filter(([id, resource]) =>
        id !== this.candidateRootId && !resource.parentId && resource.url.pathname === upstream.pathname
      );
      if (samePathDetached.length === 1) detached = samePathDetached[0];
    }
    if (detached) {
      const [id, resource] = detached;
      resource.url = upstream;
      resource.identity = identity;
      resource.parentId = parentId;
      resource.slot = slot;
      resource.urlGeneration = generation;
      this.childSlots.set(slotKey, id);
      return id;
    }

    if (this.resources.size >= MAX_BROKER_RESOURCES) throw new KinoBridgeError("BROKER_RESOURCE_LIMIT", "Broker resource limit was reached");
    const id = randomBytes(16).toString("hex");
    this.resources.set(id, {
      url: upstream,
      identity,
      parentId,
      slot,
      urlGeneration: generation,
      manifestGeneration: -1
    });
    this.childSlots.set(slotKey, id);
    return id;
  }

  private rewriteManifest(text: string, base: URL, parentId: string, generation: number): string {
    const occurrences = new Map<string, number>();
    const rewrite = (raw: string): string => {
      const identity = resourceIdentity(new URL(raw, base));
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return this.localUrl(this.registerManifestReference(raw, base, parentId, `${identity}:${occurrence}`, generation));
    };
    return text.split(/(\r?\n)/).map((line) => {
      if (/^#/.test(line)) {
        return line.replace(/URI=("([^"]+)"|([^,\s]+))/gi, (_whole, _wrapped, quoted: string | undefined, plain: string | undefined) => `URI="${rewrite(quoted ?? plain ?? "")}"`);
      }
      const trimmed = line.trim();
      if (!trimmed) return line;
      const leading = line.slice(0, line.length - line.trimStart().length);
      const trailing = line.slice(line.trimEnd().length);
      return `${leading}${rewrite(trimmed)}${trailing}`;
    }).join("");
  }

  private async fetchAllowed(initial: URL, range?: string, deadline = Date.now() + 30_000): Promise<{ response: Response; finalUrl: URL }> {
    let current = initial;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const headers = requestHeaders(this.candidate);
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range;
      const controller = new AbortController();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new KinoBridgeError("UPSTREAM_TIMEOUT", "Upstream request timed out", true);
      const timeout = setTimeout(() => controller.abort(), remaining);
      let response: Response;
      try {
        response = await fetch(current, { headers, redirect: "manual", signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new KinoBridgeError("UPSTREAM_TIMEOUT", "Upstream request timed out", true);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) {
          await response.body?.cancel();
          throw new KinoBridgeError("UPSTREAM_REDIRECT", "Upstream redirect was rejected");
        }
        await response.body?.cancel();
        current = allowedUpstream(new URL(location, current).toString(), this.allowedOrigins);
        continue;
      }
      return { response, finalUrl: current };
    }
    throw new KinoBridgeError("UPSTREAM_REDIRECT", "Too many upstream redirects");
  }

  private waitForRefresh(generation: number): Promise<number> {
    if (this.refreshGeneration > generation) return Promise.resolve(this.refreshGeneration);
    return new Promise<number>((resolve, reject) => {
      const waiter: RefreshWaiter = {
        generation,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.refreshWaiters.delete(waiter);
          if (this.refreshRequestedGeneration === generation) this.refreshRequestedGeneration = undefined;
          reject(new KinoBridgeError("AUTH_REFRESH_TIMEOUT", "Timed out waiting for refreshed stream authorization", true));
        }, AUTH_REFRESH_TIMEOUT_MS)
      };
      this.refreshWaiters.add(waiter);
    });
  }

  private async requestRefresh(generation: number): Promise<number> {
    if (this.refreshGeneration > generation) return this.refreshGeneration;
    if (!this.onAuthExpired) throw new KinoBridgeError("AUTH_EXPIRED", "Stream authorization expired", true);
    if (this.refreshRequestedGeneration !== generation) {
      this.refreshRequestedGeneration = generation;
      try {
        this.onAuthExpired();
      } catch {
        this.refreshRequestedGeneration = undefined;
        throw new KinoBridgeError("AUTH_REFRESH_FAILED", "Could not request refreshed stream authorization", true);
      }
    }
    return this.waitForRefresh(generation);
  }

  private async ensureManifestGeneration(id: string, generation: number, deadline: number, depth = 0): Promise<void> {
    if (depth > MAX_REFRESH_LINEAGE_DEPTH) {
      throw new KinoBridgeError("AUTH_REFRESH_UNRESOLVED", "Playlist lineage exceeds the supported depth", true);
    }
    const resource = this.resources.get(id);
    if (!resource) throw new KinoBridgeError("INVALID_BROKER_URL", "Broker capability is invalid or expired");
    if (resource.parentId) await this.ensureManifestGeneration(resource.parentId, generation, deadline, depth + 1);
    if (resource.urlGeneration < generation) {
      throw new KinoBridgeError("AUTH_REFRESH_UNRESOLVED", "Refreshed playlist no longer contains the requested media resource", true);
    }
    if (resource.manifestGeneration >= generation) return;
    const resourceGeneration = resource.urlGeneration;
    const fetched = await this.fetchAllowed(resource.url, undefined, deadline);
    if (fetched.response.status === 401 || fetched.response.status === 403) {
      await fetched.response.body?.cancel();
      throw new KinoBridgeError("AUTH_EXPIRED", "Refreshed stream authorization was rejected", true);
    }
    if (!fetched.response.ok) {
      await fetched.response.body?.cancel();
      throw new KinoBridgeError("UPSTREAM_ERROR", `Upstream returned HTTP ${fetched.response.status}`, fetched.response.status >= 500);
    }
    const contentType = fetched.response.headers.get("content-type") ?? "";
    if (!isManifest(fetched.finalUrl, contentType)) {
      await fetched.response.body?.cancel();
      throw new KinoBridgeError("AUTH_REFRESH_UNRESOLVED", "Resource lineage did not resolve to a playlist", true);
    }
    this.rewriteManifest(await boundedText(fetched.response), fetched.finalUrl, id, resourceGeneration);
    resource.manifestGeneration = resourceGeneration;
  }

  private async refreshResourceLineage(id: string, generation: number, deadline: number): Promise<void> {
    const resource = this.resources.get(id);
    if (!resource) throw new KinoBridgeError("INVALID_BROKER_URL", "Broker capability is invalid or expired");
    if (id === this.candidateRootId) return;
    if (!resource.parentId && this.candidateRootId) {
      await this.ensureManifestGeneration(this.candidateRootId, generation, deadline);
    }
    if (resource.parentId) await this.ensureManifestGeneration(resource.parentId, generation, deadline);
    if (resource.urlGeneration < generation) {
      throw new KinoBridgeError("AUTH_REFRESH_UNRESOLVED", "Refreshed playlist no longer contains the requested media resource", true);
    }
  }

  private async fetchWithAuthRefresh(id: string, range?: string): Promise<{ response: Response; finalUrl: URL; resourceGeneration: number }> {
    const initial = this.resources.get(id);
    if (!initial) throw new KinoBridgeError("INVALID_BROKER_URL", "Broker capability is invalid or expired");
    const generation = this.refreshGeneration;
    const initialResourceGeneration = initial.urlGeneration;
    let fetched = await this.fetchAllowed(initial.url, range);
    if (fetched.response.status !== 401 && fetched.response.status !== 403) return { ...fetched, resourceGeneration: initialResourceGeneration };
    await fetched.response.body?.cancel();

    const deadline = Date.now() + AUTH_REFRESH_TIMEOUT_MS;
    const refreshedGeneration = await this.requestRefresh(generation);
    await this.refreshResourceLineage(id, refreshedGeneration, deadline);
    const refreshed = this.resources.get(id);
    if (!refreshed) throw new KinoBridgeError("INVALID_BROKER_URL", "Broker capability is invalid or expired");
    const resourceGeneration = refreshed.urlGeneration;
    fetched = await this.fetchAllowed(refreshed.url, range, deadline);
    if (fetched.response.status === 401 || fetched.response.status === 403) {
      await fetched.response.body?.cancel();
      throw new KinoBridgeError("AUTH_EXPIRED", "Refreshed stream authorization was rejected", true);
    }
    return { ...fetched, resourceGeneration };
  }

  private async handle(method: string, path: string, range: string | undefined, outgoing: ServerResponse): Promise<void> {
    if (method !== "GET" && method !== "HEAD") throw new KinoBridgeError("METHOD_NOT_ALLOWED", "Only GET and HEAD are supported");
    const match = path.match(new RegExp(`^/${this.token}/([a-f0-9]{32})\\.[a-z0-9]{1,10}$`));
    const resourceId = match?.[1];
    if (!resourceId || !this.resources.has(resourceId)) throw new KinoBridgeError("INVALID_BROKER_URL", "Broker capability is invalid or expired");
    const { response, finalUrl, resourceGeneration } = await this.fetchWithAuthRefresh(resourceId, range);
    const responseHeaders: Record<string, string> = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
    for (const [name, value] of response.headers) {
      if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const manifest = isManifest(finalUrl, contentType);
    this.diagnosticRequestCount += 1;
    if (this.diagnosticRequestCount <= 40 || response.status >= 400) {
      log("info", "Broker upstream response", {
        sequence: this.diagnosticRequestCount,
        method,
        status: response.status,
        rangeRequested: Boolean(range),
        manifest,
        contentType: contentType.split(";", 1)[0],
        contentLength: response.headers.get("content-length") ?? undefined,
        contentRange: response.headers.get("content-range") ?? undefined
      });
    }
    if (manifest) {
      const rewritten = this.rewriteManifest(await boundedText(response), finalUrl, resourceId, resourceGeneration);
      const resource = this.resources.get(resourceId);
      if (resource) resource.manifestGeneration = resourceGeneration;
      const bytes = Buffer.byteLength(rewritten);
      outgoing.writeHead(response.status, { ...responseHeaders, "content-type": "application/vnd.apple.mpegurl", "content-length": String(bytes) });
      outgoing.end(method === "HEAD" ? undefined : rewritten);
      return;
    }
    outgoing.writeHead(response.status, responseHeaders);
    if (method === "HEAD" || !response.body) {
      outgoing.end();
      return;
    }
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).on("error", () => outgoing.destroy()).pipe(outgoing);
  }
}
