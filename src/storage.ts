import { sha256 } from "@noble/hashes/sha256";
import { toHex, ScrapeError } from "./http";
import type { ImageFormat } from "./types";

export interface ObjectStore {
  put(key: string, body: ReadableStream<Uint8Array>, options?: R2PutOptions): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(keys: string | string[]): Promise<void>;
}

export class R2StorageAdapter implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}
  put(key: string, body: ReadableStream<Uint8Array>, options?: R2PutOptions): Promise<R2Object> {
    return this.bucket.put(key, body, options);
  }
  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }
  list(options?: R2ListOptions): Promise<R2Objects> {
    return this.bucket.list(options);
  }
  delete(keys: string | string[]): Promise<void> {
    return this.bucket.delete(keys);
  }
}

export interface StreamDigestResult {
  size: number;
  sha256: string;
  prefix: Uint8Array;
  reservedBytes: number;
}

export function sniffImageFormat(prefix: Uint8Array): ImageFormat | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...prefix.slice(start, start + length));
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return { extension: "jpg", contentType: "image/jpeg" };
  if (prefix.length >= 8 && prefix[0] === 0x89 && ascii(1, 3) === "PNG" && prefix[4] === 0x0d && prefix[5] === 0x0a && prefix[6] === 0x1a && prefix[7] === 0x0a) return { extension: "png", contentType: "image/png" };
  if (prefix.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { extension: "gif", contentType: "image/gif" };
  if (prefix.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { extension: "webp", contentType: "image/webp" };
  if (prefix.length >= 12 && ascii(4, 4) === "ftyp" && /^(?:avif|avis)$/.test(ascii(8, 4))) return { extension: "avif", contentType: "image/avif" };
  if (prefix.length >= 2 && ascii(0, 2) === "BM") return { extension: "bmp", contentType: "image/bmp" };
  if (prefix.length >= 4 && ((prefix[0] === 0x49 && prefix[1] === 0x49 && prefix[2] === 0x2a && prefix[3] === 0x00) || (prefix[0] === 0x4d && prefix[1] === 0x4d && prefix[2] === 0x00 && prefix[3] === 0x2a))) return { extension: "tiff", contentType: "image/tiff" };
  if (prefix.length >= 4 && prefix[0] === 0x00 && prefix[1] === 0x00 && prefix[2] === 0x01 && prefix[3] === 0x00) return { extension: "ico", contentType: "image/x-icon" };
  const text = new TextDecoder().decode(prefix.slice(0, 512)).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return { extension: "svg", contentType: "image/svg+xml" };
  return null;
}

export function safePathSegment(value: string): string {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep encoded input */ }
  const cleaned = decoded
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 120) : "item";
}

export function imageObjectKey(jobId: string, source: URL, format: ImageFormat, sha256Hex: string): string {
  const domain = safePathSegment(source.hostname.toLowerCase());
  const rawSegments = source.pathname.split("/").filter(Boolean);
  const last = rawSegments.pop() || "image";
  const safeDirectories = rawSegments.map(safePathSegment);
  let base = safePathSegment(last).replace(/\.[^.]+$/, "");
  if (!base) base = "image";
  const filename = base.slice(0, 90) + "-" + sha256Hex.slice(0, 20) + "." + format.extension;
  return ["jobs", safePathSegment(jobId), domain, ...safeDirectories, filename].join("/");
}

const R2_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

function concatenateChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function putStreamAndHash(
  bucket: R2Bucket,
  temporaryKey: string,
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  reserve: (bytes: number) => Promise<boolean>,
  sourceContentType: string,
  sourceLength?: number
): Promise<StreamDigestResult> {
  const hasher = sha256.create();
  let size = 0;
  let reservedBytes = 0;
  const prefixParts: Uint8Array[] = [];
  let prefixLength = 0;
  const reservationBatchBytes = 256 * 1024;
  const putOptions: R2PutOptions = {
    httpMetadata: { contentType: sourceContentType || "application/octet-stream" }
  };

  const rememberChunk = (chunk: Uint8Array): void => {
    if (size + chunk.byteLength > maxBytes) throw new ScrapeError("FILE_TOO_LARGE");
    size += chunk.byteLength;
    hasher.update(chunk);
    if (prefixLength < 512) {
      const prefix = chunk.slice(0, 512 - prefixLength);
      prefixParts.push(prefix);
      prefixLength += prefix.byteLength;
    }
  };

  if (sourceLength !== undefined && Number.isSafeInteger(sourceLength) && sourceLength >= 0) {
    let pendingChunks: Uint8Array[] = [];
    let pendingBytes = 0;
    const transformed = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        rememberChunk(bytes);
        pendingChunks.push(bytes);
        pendingBytes += bytes.byteLength;
        if (pendingBytes >= reservationBatchBytes) {
          if (!await reserve(pendingBytes)) throw new ScrapeError("STORAGE_BUDGET_REACHED");
          reservedBytes += pendingBytes;
          for (const pending of pendingChunks) controller.enqueue(pending);
          pendingChunks = [];
          pendingBytes = 0;
        }
      },
      async flush(controller) {
        if (pendingBytes > 0) {
          if (!await reserve(pendingBytes)) throw new ScrapeError("STORAGE_BUDGET_REACHED");
          reservedBytes += pendingBytes;
          for (const pending of pendingChunks) controller.enqueue(pending);
        }
      }
    }));

    // R2 rejects a plain TransformStream because its readable length is unknown.
    // FixedLengthStream restores the response Content-Length and rejects short
    // or overlong source bodies before R2 can store a corrupt temporary object.
    const fixedLength = new FixedLengthStream(sourceLength);
    const pipePromise = transformed.pipeTo(fixedLength.writable);
    await Promise.all([
      bucket.put(temporaryKey, fixedLength.readable, putOptions),
      pipePromise
    ]);

    return {
      size,
      sha256: toHex(hasher.digest()),
      prefix: concatenateChunks(prefixParts, prefixLength),
      reservedBytes
    };
  }

  // If the origin omits Content-Length, R2 cannot accept an arbitrary stream.
  // Keep memory bounded by uploading complete 5 MiB parts as they arrive.
  // Small unknown-length files are stored as a fixed-size Uint8Array PUT.
  const reader = source.getReader();
  let unreservedBytes = 0;
  let partChunks: Uint8Array[] = [];
  let partBytes = 0;
  let multipart: R2MultipartUpload | null = null;
  const uploadedParts: R2UploadedPart[] = [];

  const reservePending = async (flush = false): Promise<void> => {
    if (unreservedBytes >= reservationBatchBytes || (flush && unreservedBytes > 0)) {
      const amount = unreservedBytes;
      if (!await reserve(amount)) throw new ScrapeError("STORAGE_BUDGET_REACHED");
      reservedBytes += amount;
      unreservedBytes = 0;
    }
  };

  const uploadPart = async (): Promise<void> => {
    if (!partBytes) return;
    await reservePending(true);
    const body = concatenateChunks(partChunks, partBytes);
    if (!multipart) multipart = await bucket.createMultipartUpload(temporaryKey, {
      httpMetadata: putOptions.httpMetadata
    });
    const uploaded = await multipart.uploadPart(uploadedParts.length + 1, body);
    uploadedParts.push(uploaded);
    partChunks = [];
    partBytes = 0;
  };

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      rememberChunk(bytes);
      unreservedBytes += bytes.byteLength;
      await reservePending();

      let offset = 0;
      while (offset < bytes.byteLength) {
        const take = Math.min(R2_MULTIPART_PART_BYTES - partBytes, bytes.byteLength - offset);
        partChunks.push(bytes.subarray(offset, offset + take));
        partBytes += take;
        offset += take;
        if (partBytes === R2_MULTIPART_PART_BYTES) await uploadPart();
      }
    }

    await reservePending(true);
    if (multipart) {
      if (partBytes > 0) await uploadPart();
      await multipart.complete(uploadedParts);
      multipart = null;
    } else if (size > 0) {
      await bucket.put(temporaryKey, concatenateChunks(partChunks, partBytes), putOptions);
    }
  } catch (error) {
    if (multipart) await multipart.abort().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    size,
    sha256: toHex(hasher.digest()),
    prefix: concatenateChunks(prefixParts, prefixLength),
    reservedBytes
  };
}
