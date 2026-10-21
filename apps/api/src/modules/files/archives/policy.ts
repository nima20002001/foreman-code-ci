import { MAX_FILE_BYTES } from "@foreman-code/contracts/files";

export const ZIP_LIMITS = Object.freeze({
  archiveBytes: MAX_FILE_BYTES,
  entries: 256, // Includes implicit parent directories in the filesystem node budget.
  entryBytes: MAX_FILE_BYTES,
  expandedBytes: 64 * 1024 * 1024,
  compressionRatio: 100,
  depth: 16,
  nameBytes: 1024,
  operationMs: 10_000,
});
export type ArchiveErrorCode = "invalid_archive" | "unsupported" | "unsafe_path" | "unsafe_entry"
  | "limit_exceeded" | "integrity_error" | "timeout" | "working_directory_changed";
export class ArchiveHelperError extends Error {
  constructor(readonly code: ArchiveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchiveHelperError";
  }
}
export function reject(code: ArchiveErrorCode, message: string): never { throw new ArchiveHelperError(code, message); }
export class Budget {
  private readonly deadline = performance.now() + ZIP_LIMITS.operationMs;
  remaining(): number {
    const remaining = Math.ceil(this.deadline - performance.now());
    if (remaining <= 0) reject("timeout", "ZIP operation exceeded its time budget");
    return remaining;
  }
  check(): void { this.remaining(); }
}
export function archiveSnapshot(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) reject("invalid_archive", "ZIP is empty or truncated");
  if (bytes.byteLength > ZIP_LIMITS.archiveBytes) reject("limit_exceeded", "ZIP exceeds the file byte limit");
  return Buffer.from(bytes);
}
/** Conservative portable path policy: no alternate Windows paths, normalization aliases, or devices. */
export function safeName(name: string): string[] {
  if (!name || Buffer.byteLength(name, "utf8") > ZIP_LIMITS.nameBytes || name.includes("\\")
    || name.startsWith("/") || name !== name.normalize("NFC")) reject("unsafe_path", "Unsafe ZIP entry path");
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (parts.length > ZIP_LIMITS.depth) reject("limit_exceeded", "ZIP path exceeds the depth limit");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[ .]$/.test(part) || Buffer.byteLength(part, "utf8") > 255
      || /[:<>"|?*]/.test(part) || Array.from(part).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      reject("unsafe_path", "Unsafe ZIP entry path component");
    }
  }
  return parts;
}
/** Reject case aliases, duplicate entries and file/directory prefix collisions before writing anything. */
export class PathRegistry {
  private readonly nodes = new Map<string, { name: string; directory: boolean; explicit: boolean }>();
  add(name: string): void {
    const parts = safeName(name);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      const key = path.toLowerCase();
      const explicit = i === parts.length;
      const directory = !explicit || name.endsWith("/");
      const previous = this.nodes.get(key);
      if (previous) {
        if (previous.name !== path || previous.directory !== directory || (explicit && previous.explicit)) {
          reject("unsafe_path", "Duplicate or conflicting ZIP paths");
        }
        if (explicit) previous.explicit = true;
      } else {
        this.nodes.set(key, { name: path, directory, explicit });
        if (this.nodes.size > ZIP_LIMITS.entries) reject("limit_exceeded", "ZIP exceeds the filesystem entry limit");
      }
    }
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]!;
  return (value ^ 0xffffffff) >>> 0;
}
