import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";

describe("diagnostic logging", () => {
  it("redacts credentials and signed query values", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("warn", "test", { cookie: "session=secret", url: "https://example.test/a.m3u8?token=abc&quality=hd" });
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).not.toContain("session=secret");
    expect(line).not.toContain("token=abc");
    expect(line).toContain("%5BREDACTED%5D");
    write.mockRestore();
  });
});
