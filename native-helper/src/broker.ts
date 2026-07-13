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
const FORWARDED_RESPONSE_HEADERS = new Set(["content-type", "accept-ranges", "content-range", "cache-control", "last-modified", "etag"]);

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
  private readonly resources = new Map<string, URL>();
  private readonly allowedOrigins: Set<string>;
  private server: Server | undefined;
  private port: number | undefined;
  private entryId: string | undefined;
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
    const entryId = this.register(entryUrl);
    this.entryId = entryId;
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
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.resources.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  refresh(candidate: StreamCandidate): void {
    const next = allowedUpstream(candidate.url, this.allowedOrigins);
    this.candidate = candidate;
    if (this.entryId) this.resources.set(this.entryId, next);
  }

  private localUrl(id: string): string {
    if (!this.port) throw new KinoBridgeError("BROKER_NOT_STARTED", "Broker is not running");
    const upstream = this.resources.get(id);
    const extension = upstream?.pathname.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
    const safeExtension = extension && /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ".bin";
    return `http://127.0.0.1:${this.port}/${this.token}/${id}${safeExtension}`;
  }

  private register(raw: string, base?: URL): string {
    const upstream = allowedUpstream(new URL(raw, base).toString(), this.allowedOrigins);
    for (const [existingId, existingUrl] of this.resources) {
      if (existingUrl.toString() === upstream.toString()) return existingId;
    }
    if (this.resources.size >= MAX_BROKER_RESOURCES) throw new KinoBridgeError("BROKER_RESOURCE_LIMIT", "Broker resource limit was reached");
    const id = randomBytes(16).toString("hex");
    this.resources.set(id, upstream);
    return id;
  }

  private registerManifestReference(raw: string, base: URL): string {
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
    return this.register(referenced.toString());
  }

  private rewriteManifest(text: string, base: URL): string {
    const rewrite = (raw: string): string => this.localUrl(this.registerManifestReference(raw, base));
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

  private async fetchAllowed(initial: URL, range?: string): Promise<{ response: Response; finalUrl: URL }> {
    let current = initial;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const headers = requestHeaders(this.candidate);
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let response: Response;
      try {
        response = await fetch(current, { headers, redirect: "manual", signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new KinoBridgeError("UPSTREAM_REDIRECT", "Upstream redirect was rejected");
        current = allowedUpstream(new URL(location, current).toString(), this.allowedOrigins);
        continue;
      }
      return { response, finalUrl: current };
    }
    throw new KinoBridgeError("UPSTREAM_REDIRECT", "Too many upstream redirects");
  }

  private async handle(method: string, path: string, range: string | undefined, outgoing: ServerResponse): Promise<void> {
    if (method !== "GET" && method !== "HEAD") throw new KinoBridgeError("METHOD_NOT_ALLOWED", "Only GET and HEAD are supported");
    const match = path.match(new RegExp(`^/${this.token}/([a-f0-9]{32})\\.[a-z0-9]{1,10}$`));
    const upstream = match?.[1] ? this.resources.get(match[1]) : undefined;
    if (!upstream) throw new KinoBridgeError("INVALID_BROKER_URL", "Broker capability is invalid or expired");
    const { response, finalUrl } = await this.fetchAllowed(upstream, range);
    if (response.status === 401 || response.status === 403) {
      this.onAuthExpired?.();
      throw new KinoBridgeError("AUTH_EXPIRED", "Stream authorization expired", true);
    }
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
      const rewritten = this.rewriteManifest(await boundedText(response), finalUrl);
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
