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
  const filename = base.slice(0, 90) + "-" + sha256Hex.slice(0, 12) + "." + format.extension;
  return ["jobs", safePathSegment(jobId), domain, ...safeDirectories, filename].join("/");
}

export async function putStreamAndHash(
  bucket: R2Bucket,
  temporaryKey: string,
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  reserve: (bytes: number) => Promise<boolean>,
  sourceContentType: string
): Promise<StreamDigestResult> {
  const hasher = sha256.create();
  let size = 0;
  let reservedBytes = 0;
  const prefixParts: Uint8Array[] = [];
  let prefixLength = 0;
  let digest = "";

  const transformed = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (size + bytes.byteLength > maxBytes) throw new ScrapeError("FILE_TOO_LARGE");
      const permitted = await reserve(bytes.byteLength);
      if (!permitted) throw new ScrapeError("STORAGE_BUDGET_REACHED");
      size += bytes.byteLength;
      reservedBytes += bytes.byteLength;
      hasher.update(bytes);
      if (prefixLength < 512) {
        const part = bytes.slice(0, 512 - prefixLength);
        prefixParts.push(part);
        prefixLength += part.byteLength;
      }
      controller.enqueue(bytes);
    },
    flush() {
      digest = toHex(hasher.digest());
    }
  }));

  await bucket.put(temporaryKey, transformed, {
    httpMetadata: { contentType: sourceContentType || "application/octet-stream" }
  });

  const prefix = new Uint8Array(prefixLength);
  let offset = 0;
  for (const part of prefixParts) {
    prefix.set(part, offset);
    offset += part.byteLength;
  }
  return { size, sha256: digest, prefix, reservedBytes };
}