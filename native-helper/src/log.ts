import { redactUrl } from "@kinobridge/shared";

const REDACTED_FIELDS = /cookie|authorization|token|signature|secret|password/i;

function redact(value: unknown, key = ""): unknown {
  if (REDACTED_FIELDS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function log(level: "info" | "warn" | "error", message: string, context?: unknown): void {
  // Native Messaging reserves stdout exclusively for framed protocol data.
  const record = { timestamp: new Date().toISOString(), level, message, ...(context === undefined ? {} : { context: redact(context) }) };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
