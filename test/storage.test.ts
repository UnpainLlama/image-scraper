import { describe, expect, it, vi } from "vitest";
import { imageObjectKey, putStreamAndHash, safePathSegment, sniffImageFormat } from "../src/storage";

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

describe("R2 stream uploads", () => {
  function concatenate(chunks: Uint8Array[], length: number): Uint8Array {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  function collectingBucket() {
    const stored = new Map<string, Uint8Array>();
    const bucket = {
      put: vi.fn(async (key: string, value: ReadableStream<Uint8Array> | Uint8Array) => {
        let bytes: Uint8Array;
        if (value instanceof ReadableStream) {
          const reader = value.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value);
            length += next.value.byteLength;
          }
          bytes = concatenate(chunks, length);
        } else {
          bytes = new Uint8Array(value);
        }
        stored.set(key, bytes);
        return { key, size: bytes.byteLength } as R2Object;
      }),
      createMultipartUpload: vi.fn(async (key: string) => {
        const parts: Uint8Array[] = [];
        return {
          key,
          uploadId: "test-upload",
          uploadPart: vi.fn(async (partNumber: number, body: Uint8Array) => {
            parts[partNumber - 1] = new Uint8Array(body);
            return { partNumber, etag: "part-" + partNumber };
          }),
          complete: vi.fn(async (uploaded: R2UploadedPart[]) => {
            expect(uploaded).toHaveLength(parts.length);
            const body = concatenate(parts, parts.reduce((sum, part) => sum + part.byteLength, 0));
            stored.set(key, body);
            return { key, size: body.byteLength } as R2Object;
          }),
          abort: vi.fn(async () => {})
        } as unknown as R2MultipartUpload;
      })
    };
    return { bucket: bucket as unknown as R2Bucket, stored };
  }

  it("uploads known-length streams through FixedLengthStream", async () => {
    const { bucket, stored } = collectingBucket();
    const content = new TextEncoder().encode("GIF89a-known-length");
    const reserve = vi.fn(async () => true);
    const result = await putStreamAndHash(
      bucket, "tmp/known.gif", new Response(content).body!, 1024, reserve, "image/gif", content.byteLength
    );
    expect(stored.get("tmp/known.gif")).toEqual(content);
    expect(result.size).toBe(content.byteLength);
    expect(result.prefix).toEqual(content);
    expect(reserve).toHaveBeenCalled();
  });

  it("uses a fixed-size PUT for unknown-length files smaller than a multipart part", async () => {
    const { bucket, stored } = collectingBucket();
    const content = new TextEncoder().encode("GIF89a-unknown-length");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content.slice(0, 6));
        controller.enqueue(content.slice(6));
        controller.close();
      }
    });
    const result = await putStreamAndHash(bucket, "tmp/unknown.gif", source, 1024, async () => true, "image/gif");
    expect(stored.get("tmp/unknown.gif")).toEqual(content);
    expect(result.size).toBe(content.byteLength);
    expect(bucket.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("uploads unknown-length files larger than 5 MiB with R2 multipart", async () => {
    const { bucket, stored } = collectingBucket();
    const content = new Uint8Array(5 * 1024 * 1024 + 17);
    content.set(new TextEncoder().encode("GIF89a"));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content.slice(0, 2 * 1024 * 1024));
        controller.enqueue(content.slice(2 * 1024 * 1024));
        controller.close();
      }
    });
    const result = await putStreamAndHash(bucket, "tmp/large.gif", source, content.byteLength + 1, async () => true, "image/gif");
    expect(stored.get("tmp/large.gif")).toEqual(content);
    expect(result.size).toBe(content.byteLength);
    expect(bucket.createMultipartUpload).toHaveBeenCalledOnce();
  });

  it("rejects an incorrect Content-Length instead of storing a truncated object", async () => {
    const { bucket, stored } = collectingBucket();
    const content = new TextEncoder().encode("short");
    await expect(putStreamAndHash(
      bucket, "tmp/truncated.bin", new Response(content).body!, 1024, async () => true,
      "application/octet-stream", content.byteLength + 1
    )).rejects.toThrow();
    expect(stored.has("tmp/truncated.bin")).toBe(false);
  });
});
