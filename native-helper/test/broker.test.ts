import { get } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamCandidateSchema } from "@kinobridge/shared";
import { AccessBroker } from "../src/broker.js";

function read(url: string): Promise<{ status: number | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    }).once("error", reject);
  });
}

const candidate = StreamCandidateSchema.parse({
  id: "candidate-1",
  tabId: 1,
  navigationId: "nav-1",
  requestId: "request-1",
  url: "https://media.example.test/master.m3u8?token=secret",
  pageUrl: "https://kino.pub/item/1",
  pageTitle: "Fixture",
  observedAt: 1,
  access: { referer: "https://kino.pub/item/1", cookie: "session=secret", headers: [] }
});

afterEach(() => vi.restoreAllMocks());

describe("loopback access broker", () => {
  it("rewrites playlists to opaque loopback capabilities", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"
#EXTINF:4,
segments/one.ts?token=segment-secret
`, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } }));
    const broker = new AccessBroker(candidate);
    try {
      const entry = await broker.start();
      const response = await read(entry);
      expect(response.status).toBe(200);
      expect(entry).toMatch(/\.m3u8$/);
      expect(response.text).toMatch(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/[a-f0-9]{32}\.ts/);
      expect(response.text).not.toContain("media.example.test");
      expect(response.text).not.toContain("segment-secret");
      expect(upstreamFetch).toHaveBeenCalledWith(expect.objectContaining({ origin: "https://media.example.test" }), expect.objectContaining({ redirect: "manual" }));
      const sentHeaders = (upstreamFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
      expect(sentHeaders.cookie).toBe("session=secret");
      expect(sentHeaders["accept-encoding"]).toBe("identity");
    } finally {
      await broker.close();
    }
  });

  it("rejects a redirect to a different origin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    const broker = new AccessBroker(candidate);
    try {
      const entry = await broker.start();
      const response = await read(entry);
      expect(response.status).toBe(400);
      expect(response.text).not.toContain("evil.example");
    } finally {
      await broker.close();
    }
  });

  it("allows only additional CDN origins parsed from the validated master", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const upstream = new URL(String(url));
      if (upstream.hostname === "media.example.test") {
        return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://video.example.test/variant.m3u8\n", {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" }
        });
      }
      return new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" }
      });
    });
    const broker = new AccessBroker(candidate);
    try {
      const master = await read(await broker.start());
      const rewrittenVariant = master.text.split(/\r?\n/).find((line) => line.startsWith("http://127.0.0.1"));
      expect(rewrittenVariant).toBeTruthy();
      const variant = await read(rewrittenVariant!);
      expect(variant.status).toBe(200);
      expect(upstreamFetch.mock.calls.some(([url]) => new URL(String(url)).hostname === "video.example.test")).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it("rejects local or IP-literal origins introduced by a playlist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://127.0.0.1/private.m3u8\n",
      { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } }
    ));
    const broker = new AccessBroker(candidate);
    try {
      const response = await read(await broker.start());
      expect(response.status).toBe(400);
      expect(response.text).not.toContain("127.0.0.1/private");
    } finally {
      await broker.close();
    }
  });

  it("does not forward a stale upstream content length for streamed bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("expanded-body", {
      status: 200,
      headers: { "content-type": "video/mp2t", "content-length": "3" }
    }));
    const mediaCandidate = StreamCandidateSchema.parse({ ...candidate, url: "https://media.example.test/segment.ts" });
    const broker = new AccessBroker(mediaCandidate);
    try {
      const response = await read(await broker.start());
      expect(response.status).toBe(200);
      expect(response.text).toBe("expanded-body");
    } finally {
      await broker.close();
    }
  });
});
