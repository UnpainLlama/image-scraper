import { describe, expect, it } from "vitest";
import { imageObjectKey, safePathSegment, sniffImageFormat } from "../src/storage";

describe("image format detection", () => {
  it("detects PNG and WebP signatures", () => {
    expect(sniffImageFormat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))?.extension).toBe("png");
    expect(sniffImageFormat(new TextEncoder().encode("RIFF0000WEBP"))?.extension).toBe("webp");
  });

  it("detects both GIF signatures and retains the GIF media type", () => {
    expect(sniffImageFormat(new TextEncoder().encode("GIF87a"))).toEqual({
      extension: "gif",
      contentType: "image/gif"
    });
    expect(sniffImageFormat(new TextEncoder().encode("GIF89a"))).toEqual({
      extension: "gif",
      contentType: "image/gif"
    });
  });

  it("rejects non-image content", () => {
    expect(sniffImageFormat(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
  });
});

describe("R2 key safety", () => {
  it("removes traversal and unsafe path characters", () => {
    expect(safePathSegment("../private")).toBe("_private");
    expect(imageObjectKey("job-1", new URL("https://example.com/a/b.jpg"), { extension: "jpg", contentType: "image/jpeg" }, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"))
      .toBe("jobs/job-1/example.com/a/b-abcdef0123456789abcd.jpg");
  });
});