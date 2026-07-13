import { describe, expect, it } from "vitest";
import { encodeNativeMessage, MAX_NATIVE_MESSAGE_BYTES, NativeMessageDecoder } from "../src/framing.js";

async function decode(chunks: Buffer[]): Promise<unknown[]> {
  const decoder = new NativeMessageDecoder();
  const values: unknown[] = [];
  decoder.on("data", (value) => values.push(value));
  for (const chunk of chunks) decoder.write(chunk);
  decoder.end();
  await new Promise<void>((resolve, reject) => {
    decoder.once("end", resolve);
    decoder.once("error", reject);
  });
  return values;
}

describe("Native Messaging framing", () => {
  it("decodes fragmented multibyte JSON and consecutive messages", async () => {
    const first = encodeNativeMessage({ text: "电影 🎬" });
    const second = encodeNativeMessage({ ok: true });
    const combined = Buffer.concat([first, second]);
    const values = await decode([combined.subarray(0, 2), combined.subarray(2, 9), combined.subarray(9)]);
    expect(values).toEqual([{ text: "电影 🎬" }, { ok: true }]);
  });

  it("rejects oversized declared messages before allocation", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1);
    await expect(decode([header])).rejects.toThrow("exceeds 1 MiB");
  });

  it("rejects truncated input", async () => {
    const message = encodeNativeMessage({ ok: true });
    await expect(decode([message.subarray(0, message.length - 1)])).rejects.toThrow("ended before");
  });
});
