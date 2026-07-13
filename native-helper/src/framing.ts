import { Transform, type TransformCallback } from "node:stream";
import { KinoBridgeError } from "./errors.js";

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new KinoBridgeError("MESSAGE_TOO_LARGE", "Native message exceeds 1 MiB");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder extends Transform {
  private buffered = Buffer.alloc(0);

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.buffered = Buffer.concat([this.buffered, incoming]);
      while (this.buffered.length >= 4) {
        const size = this.buffered.readUInt32LE(0);
        if (size > MAX_NATIVE_MESSAGE_BYTES) throw new KinoBridgeError("MESSAGE_TOO_LARGE", "Native message exceeds 1 MiB");
        if (this.buffered.length < size + 4) break;
        const body = this.buffered.subarray(4, size + 4);
        this.buffered = this.buffered.subarray(size + 4);
        try {
          this.push(JSON.parse(body.toString("utf8")));
        } catch {
          throw new KinoBridgeError("INVALID_JSON", "Native message is not valid JSON");
        }
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffered.length !== 0) callback(new KinoBridgeError("TRUNCATED_MESSAGE", "Native message ended before its declared length"));
    else callback();
  }
}
