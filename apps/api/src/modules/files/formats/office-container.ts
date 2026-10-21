import { fail } from "./policy.js";

/** Metadata-only CFB probe. Never reads, decrypts, or executes an embedded Office stream. */
export function rejectOfficeContainer(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) return;
  const invalid = (): never => fail("corrupt", "Malformed Office compound container");
  if (bytes.length < 512 || bytes.readUInt16LE(28) !== 0xfffe) invalid();
  const version = bytes.readUInt16LE(26);
  const shift = bytes.readUInt16LE(30);
  if (!((version === 3 && shift === 9) || (version === 4 && shift === 12))) invalid();
  const size = 2 ** shift;
  if (bytes.length % size !== 0) invalid();
  const count = bytes.length / size - 1;
  const sector = (id: number): Buffer => {
    if (id >= count) return invalid();
    return bytes.subarray((id + 1) * size, (id + 2) * size);
  };
  const FREE = 0xffffffff, END = 0xfffffffe, FAT = 0xfffffffd, DIFAT = 0xfffffffc;
  const fatCount = bytes.readUInt32LE(44);
  if (!fatCount || fatCount > count) invalid();
  const fatIds: number[] = [];
  for (let index = 0; index < 109; index++) {
    const id = bytes.readUInt32LE(76 + index * 4);
    if (id !== FREE) fatIds.push(id);
  }
  const difatSeen = new Set<number>();
  let nextDifat = bytes.readUInt32LE(68);
  const difatCount = bytes.readUInt32LE(72);
  if (difatCount > count) invalid();
  for (let index = 0; index < difatCount; index++) {
    if (difatSeen.has(nextDifat)) invalid();
    difatSeen.add(nextDifat);
    const block = sector(nextDifat);
    for (let offset = 0; offset < size - 4; offset += 4) {
      const id = block.readUInt32LE(offset);
      if (id !== FREE) fatIds.push(id);
      if (fatIds.length > fatCount) invalid();
    }
    nextDifat = block.readUInt32LE(size - 4);
  }
  if (nextDifat !== END || fatIds.length !== fatCount || new Set(fatIds).size !== fatCount) invalid();
  const fat = Buffer.concat(fatIds.map(sector));
  const next = (id: number): number => id * 4 + 4 <= fat.length ? fat.readUInt32LE(id * 4) : invalid();
  for (const id of fatIds) if (next(id) !== FAT) invalid();
  for (const id of difatSeen) if (next(id) !== DIFAT) invalid();
  const directory: Buffer[] = [];
  const seen = new Set<number>();
  let id = bytes.readUInt32LE(48);
  while (id !== END) {
    if (seen.has(id) || seen.size >= count) invalid();
    if ((directory.length + 1) * size > 1024 * 1024) fail("too_large", "Office directory exceeds its metadata limit");
    seen.add(id);
    directory.push(sector(id));
    id = next(id);
  }
  if (!directory.length) invalid();
  const entries = Buffer.concat(directory);
  const entry = (index: number): Buffer => index * 128 + 128 <= entries.length
    ? entries.subarray(index * 128, index * 128 + 128) : invalid();
  const root = entry(0);
  if (root[66] !== 5) invalid();
  const pending = [root.readUInt32LE(76)];
  const visited = new Set<number>();
  const names = new Set<string>();
  while (pending.length) {
    const index = pending.pop()!;
    if (index === FREE) continue;
    if (visited.has(index)) invalid();
    visited.add(index);
    const item = entry(index);
    const length = item.readUInt16LE(64);
    if (length < 2 || length > 64 || length % 2 || item.readUInt16LE(length - 2) !== 0) invalid();
    if (item[66] !== 1 && item[66] !== 2) invalid();
    const name = item.subarray(0, length - 2).toString("utf16le");
    if (item[66] === 2) names.add(name);
    pending.push(item.readUInt32LE(68), item.readUInt32LE(72));
    // Only siblings in the root storage: names hidden in arbitrary sub-storages do not count.
  }
  if (names.has("EncryptionInfo") && names.has("EncryptedPackage")) {
    fail("encrypted", "Office container declares encrypted package streams; passwords are not supported");
  }
  fail("unsupported", "Office compound container is not a supported DOCX ZIP");
}
