import type { AccessContext } from "./protocol.js";

const SENSITIVE_QUERY_KEYS = /^(token|sig|signature|expires|exp|key|auth|session)$/i;
const SAFE_HEADERS = new Set(["accept", "accept-language", "origin", "referer", "user-agent"]);

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return "[INVALID_URL]";
  }
}

export function minimalAccessContext(access: AccessContext): AccessContext {
  return {
    ...(access.referer ? { referer: access.referer } : {}),
    ...(access.userAgent ? { userAgent: access.userAgent } : {}),
    ...(access.cookie ? { cookie: access.cookie } : {}),
    headers: access.headers.filter((header) => SAFE_HEADERS.has(header.name.toLowerCase()))
  };
}

export function assertSafeUpstream(raw: string, allowedOrigins: ReadonlySet<string>): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) {
    throw new Error("Upstream URL is not an allowed HTTPS origin");
  }
  if (url.username || url.password) throw new Error("Credentials in URLs are forbidden");
  return url;
}

export function sanitizeFilename(input: string): string {
  const normalized = input.normalize("NFKC").replace(/[\x00-\x1f\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  const safe = normalized.replace(/^[.\-\s]+/, "").slice(0, 200);
  return safe || "KinoBridge-download";
}
