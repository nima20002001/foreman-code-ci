import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { ArchiveHelperError, Budget, PathRegistry, ZIP_LIMITS, crc32, reject } from "./policy.js";

export interface ZipEntry {
  name: string;
  kind: "file" | "directory";
  compressedBytes: number;
  uncompressedBytes: number;
  compression: "stored" | "deflate";
}
export interface ParsedEntry extends ZipEntry {
  checksum: number;
  dataOffset: number;
}
function range(bytes: Buffer, offset: number, size: number, limit = bytes.length): void {
  if (offset < 0 || size < 0 || offset + size > Math.min(bytes.length, limit)) reject("invalid_archive", "Truncated ZIP structure");
}
function extras(bytes: Buffer): void {
  let position = 0;
  while (position < bytes.length) {
    range(bytes, position, 4);
    const kind = bytes.readUInt16LE(position);
    const size = bytes.readUInt16LE(position + 2);
    range(bytes, position + 4, size);
    // ZIP64, AES, Unicode alternate paths, and Unix link metadata are deliberately not supported.
    if ([0x0001, 0x000d, 0x9901, 0x7075, 0x756e].includes(kind)) reject("unsupported", "Unsupported ZIP extra field");
    position += 4 + size;
  }
}
function nameFrom(bytes: Buffer, flags: number): string {
  if (!(flags & 0x0800) && bytes.some((byte) => byte > 127)) reject("unsupported", "Legacy non-ASCII ZIP names are not supported");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    return reject("unsafe_path", "Invalid UTF-8 ZIP entry name");
  }
}
function findEnd(bytes: Buffer): number {
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 22 - 65535); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) return position;
  }
  return reject("invalid_archive", "Missing ZIP end-of-central-directory record");
}
/** Parse the complete index, even for a selective extraction. No inflation occurs here. */
export function parseZip(bytes: Buffer, budget: Budget): ParsedEntry[] {
  const end = findEnd(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const directoryBytes = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== count) reject("unsupported", "Split ZIP archives are not supported");
  if (count === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) reject("unsupported", "ZIP64 is not supported");
  if (count > ZIP_LIMITS.entries) reject("limit_exceeded", "ZIP exceeds entry count limit");
  if (directoryOffset + directoryBytes !== end) reject("invalid_archive", "Invalid central directory bounds");
  const registry = new PathRegistry();
  const entries: ParsedEntry[] = [];
  const spans: { start: number; end: number }[] = [];
  let position = directoryOffset;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    budget.check();
    range(bytes, position, 46, end);
    if (bytes.readUInt32LE(position) !== 0x02014b50) reject("invalid_archive", "Invalid central directory header");
    const version = bytes.readUInt16LE(position + 6);
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const checksum = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20);
    const uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const attributes = bytes.readUInt32LE(position + 38);
    const local = bytes.readUInt32LE(position + 42);
    if (version > 20 || (flags & ~0x080e) !== 0 || ![0, 8].includes(method)
      || bytes.readUInt16LE(position + 34) !== 0) reject("unsupported", "Unsupported or encrypted ZIP entry");
    if ([compressed, uncompressed, local].includes(0xffffffff)) reject("unsupported", "ZIP64 is not supported");
    if (method === 0 && ((flags & 6) !== 0 || compressed !== uncompressed)) reject("invalid_archive", "Invalid stored entry size or flags");
    if (uncompressed > ZIP_LIMITS.entryBytes || (expanded += uncompressed) > ZIP_LIMITS.expandedBytes
      || uncompressed > Math.max(1, compressed) * ZIP_LIMITS.compressionRatio) reject("limit_exceeded", "ZIP exceeds expansion limits");
    if (nameLength > ZIP_LIMITS.nameBytes) reject("limit_exceeded", "ZIP entry name is too long");
    range(bytes, position + 46, nameLength + extraLength + commentLength, end);
    const rawName = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = nameFrom(rawName, flags);
    registry.add(name);
    const directory = name.endsWith("/");
    const fileType = (attributes >>> 16) & 0xf000;
    if (![0, 0x4000, 0x8000].includes(fileType) || (attributes & 0x400) !== 0) reject("unsafe_entry", "ZIP links and special files are forbidden");
    if ((fileType === 0x4000 || (attributes & 0x10) !== 0) && !directory) reject("unsafe_entry", "Directory type disagrees with ZIP path");
    if (directory && (fileType === 0x8000 || uncompressed !== 0 || checksum !== 0)) {
      reject("unsafe_entry", "Invalid ZIP directory entry");
    }
    extras(bytes.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength));
    range(bytes, local, 30, directoryOffset);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== version
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) {
      reject("invalid_archive", "Local and central ZIP headers disagree");
    }
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    range(bytes, local + 30, localNameLength + localExtraLength, directoryOffset);
    if (!bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName)) reject("unsafe_path", "Local and central entry names disagree");
    extras(bytes.subarray(local + 30 + localNameLength, local + 30 + localNameLength + localExtraLength));
    const descriptor = (flags & 8) !== 0;
    for (const [offset, expected] of [[14, checksum], [18, compressed], [22, uncompressed]] as const) {
      const actual = bytes.readUInt32LE(local + offset);
      if (actual !== expected && !(descriptor && actual === 0)) reject("invalid_archive", "Local ZIP sizes or CRC disagree");
    }
    const dataOffset = local + 30 + localNameLength + localExtraLength;
    range(bytes, dataOffset, compressed, directoryOffset);
    let spanEnd = dataOffset + compressed;
    if (descriptor) {
      range(bytes, spanEnd, 12, directoryOffset);
      const signed = spanEnd + 16 <= directoryOffset && bytes.readUInt32LE(spanEnd) === 0x08074b50
        && bytes.readUInt32LE(spanEnd + 4) === checksum && bytes.readUInt32LE(spanEnd + 8) === compressed
        && bytes.readUInt32LE(spanEnd + 12) === uncompressed;
      const start = spanEnd + (signed ? 4 : 0);
      if (bytes.readUInt32LE(start) !== checksum || bytes.readUInt32LE(start + 4) !== compressed
        || bytes.readUInt32LE(start + 8) !== uncompressed) reject("invalid_archive", "Invalid ZIP data descriptor");
      spanEnd += signed ? 16 : 12;
    }
    spans.push({ start: local, end: spanEnd });
    entries.push({ name, kind: directory ? "directory" : "file", compressedBytes: compressed,
      uncompressedBytes: uncompressed, compression: method === 0 ? "stored" : "deflate", checksum, dataOffset });
    position += 46 + nameLength + extraLength + commentLength;
  }
  if (position !== end) reject("invalid_archive", "Central directory size or count disagrees");
  let covered = 0;
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.start !== covered) reject("invalid_archive", "Overlapping, hidden, or prefixed ZIP entries");
    covered = span.end;
  }
  if (covered !== directoryOffset) reject("invalid_archive", "Unindexed ZIP data is forbidden");
  return entries;
}
export function publicEntry(entry: ParsedEntry): ZipEntry {
  return { name: entry.name, kind: entry.kind, compressedBytes: entry.compressedBytes,
    uncompressedBytes: entry.uncompressedBytes, compression: entry.compression };
}
export async function decodeEntry(bytes: Buffer, entry: ParsedEntry, budget: Budget): Promise<Buffer> {
  budget.check();
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes);
  let result: Buffer;
  if (entry.compression === "stored") {
    result = compressed;
  } else {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let size = 0;
    const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > entry.uncompressedBytes || size > ZIP_LIMITS.entryBytes) {
        done(new ArchiveHelperError("limit_exceeded", "Inflated bytes exceed the declared or permitted size"));
      } else { chunks.push(chunk); done(); }
    } });
    const timer = setTimeout(() => inflater.destroy(new ArchiveHelperError("timeout", "ZIP inflation exceeded its time budget")), budget.remaining());
    try {
      await pipeline(Readable.from([compressed]), inflater, sink);
      if (inflater.bytesWritten !== compressed.length) reject("integrity_error", "Trailing compressed data is forbidden");
      result = Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof ArchiveHelperError) throw error;
      throw new ArchiveHelperError("integrity_error", "Invalid deflate stream", { cause: error });
    } finally { clearTimeout(timer); }
  }
  budget.check();
  if (result.length !== entry.uncompressedBytes || crc32(result) !== entry.checksum) reject("integrity_error", "ZIP entry length or CRC mismatch");
  budget.check();
  return result;
}
/** Deterministic classic STORE ZIP. Contents are never run, interpreted, or recursively unpacked. */
export function packEntries(entries: readonly { name: string; bytes: Buffer }[], budget: Budget): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    budget.check();
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x21, 12); // 1980-01-01; no leaking host timestamps.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix creator, ZIP 2.0.
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(((entry.name.endsWith("/") ? 0o40700 : 0o100600) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localChunks.push(local, name, entry.bytes);
    centralChunks.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
    centralSize += central.length + name.length;
    if (offset + centralSize + 22 > ZIP_LIMITS.archiveBytes) reject("limit_exceeded", "Repacked ZIP exceeds the file byte limit");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  budget.check();
  return Buffer.concat([...localChunks, ...centralChunks, end], offset + centralSize + 22);
}
