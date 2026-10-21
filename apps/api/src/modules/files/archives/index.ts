import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, rm } from "node:fs/promises";
import path from "node:path";
import { ArchiveHelperError, Budget, PathRegistry, ZIP_LIMITS, archiveSnapshot, reject, safeName } from "./policy.js";
import { decodeEntry, packEntries, parseZip, publicEntry, type ZipEntry } from "./zip.js";

export { ArchiveHelperError, ZIP_LIMITS } from "./policy.js";
export type { ArchiveErrorCode } from "./policy.js";
export type { ZipEntry } from "./zip.js";
export interface ExtractedZip {
  /** Private host path for the runner/service only. Never expose this as an artifact ID or tool input. */
  workingDirectory: string;
  entries: ZipEntry[];
}
/** Metadata-only listing. Payload length and CRC are verified only when the selected entry is extracted. */
export function listZip(input: Uint8Array): ZipEntry[] {
  const budget = new Budget();
  return parseZip(archiveSnapshot(input), budget).map(publicEntry);
}
function noFollow(): number {
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) reject("unsupported", "This platform cannot safely open working files without following links");
  return constants.O_NOFOLLOW;
}
/** Reject symlink components as well as a symlink root. The caller must exclusively own this tree. */
async function checkedDirectory(directory: string, budget: Budget): Promise<string> {
  if (!path.isAbsolute(directory)) reject("unsafe_path", "Working directory must be an absolute server-owned path");
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of ["", ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {
    budget.check();
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) reject("unsafe_path", "Working directory contains a link or non-directory component");
  }
  return resolved;
}
async function makeDirectories(root: string, parts: readonly string[], budget: Budget): Promise<void> {
  let current = root;
  for (const part of parts) {
    budget.check();
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) reject("unsafe_path", "Extraction parent is not a real directory");
  }
}
/**
 * Extract exactly the named entries (or all when omitted) into a NEW private child of parentDirectory.
 * Selecting a directory creates that directory only, not its descendants. [] creates an empty workspace.
 * The caller owns parentDirectory and must exclude concurrent untrusted writers for the entire operation.
 */
export async function extractZip(input: Uint8Array, parentDirectory: string, names?: readonly string[]): Promise<ExtractedZip> {
  const budget = new Budget();
  const bytes = archiveSnapshot(input);
  const entries = parseZip(bytes, budget); // Validate all paths before the first filesystem mutation.
  let selected = entries;
  if (names !== undefined) {
    if (names.length > ZIP_LIMITS.entries || new Set(names).size !== names.length) reject("unsafe_path", "Invalid extraction selection");
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    selected = names.map((name) => {
      safeName(name);
      const entry = byName.get(name);
      if (!entry) reject("invalid_archive", "Requested ZIP entry does not exist");
      return entry;
    });
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow();
  const parent = await checkedDirectory(parentDirectory, budget);
  const workingDirectory = await mkdtemp(path.join(parent, "fil07-")); // mkdtemp creates mode 0700.
  try {
    for (const entry of selected) {
      budget.check();
      const parts = safeName(entry.name);
      await makeDirectories(workingDirectory, entry.kind === "directory" ? parts : parts.slice(0, -1), budget);
      const content = await decodeEntry(bytes, entry, budget);
      if (entry.kind === "directory") continue;
      const file = await open(path.join(workingDirectory, ...parts), flags, 0o600);
      try { await file.writeFile(content); } finally { await file.close(); }
    }
    budget.check();
    return { workingDirectory, entries: selected.map(publicEntry) };
  } catch (error) {
    // Never return a partially extracted workspace. Delete only the private directory created above.
    try { await rm(workingDirectory, { recursive: true, force: true }); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Extraction failed and private workspace cleanup also failed", { cause: cleanupError });
    }
    throw error;
  }
}
interface WorkingEntry { name: string; absolute: string; stats: Stats }
function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && after.nlink === 1 && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function readWorkingFile(entry: WorkingEntry, budget: Budget): Promise<Buffer> {
  // O_NONBLOCK prevents opening a swapped-in FIFO from blocking before fstat can reject it.
  const file = await open(entry.absolute, constants.O_RDONLY | noFollow() | constants.O_NONBLOCK);
  try {
    if (!sameFile(entry.stats, await file.stat())) reject("working_directory_changed", "Working file changed before repack");
    const bytes = Buffer.alloc(entry.stats.size + 1); // One extra byte detects growth, without unbounded readFile allocation.
    let size = 0;
    while (size < bytes.length) {
      budget.check();
      const result = await file.read(bytes, size, Math.min(64 * 1024, bytes.length - size), size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size !== entry.stats.size || !sameFile(entry.stats, await file.stat())) reject("working_directory_changed", "Working file changed during repack");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
/**
 * Repack an exclusively-owned, quiescent working directory. Reject links (including hard links),
 * devices and FIFOs. Use STORE to avoid encoder CPU spikes; large trees can exceed the ZIP byte cap.
 * No permissions, timestamps, executable bits, host paths or contents are executed/restored.
 */
export async function repackZip(workingDirectory: string): Promise<Buffer> {
  const budget = new Budget();
  noFollow();
  const root = await checkedDirectory(workingDirectory, budget);
  const registry = new PathRegistry();
  const entries: WorkingEntry[] = [];
  let expanded = 0;
  let outputBytes = 22;
  async function walk(directory: string, prefix: string): Promise<void> {
    const stream = await opendir(directory); // Bounded iteration, not readdir of an arbitrarily large directory.
    for await (const dirent of stream) {
      budget.check();
      const absolute = path.join(directory, dirent.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()) || (stats.isFile() && stats.nlink !== 1)) {
        reject("unsafe_entry", "Working directory contains a link or special file");
      }
      const name = `${prefix}${dirent.name}${stats.isDirectory() ? "/" : ""}`;
      registry.add(name);
      const size = stats.isFile() ? stats.size : 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > ZIP_LIMITS.entryBytes
        || (expanded += size) > ZIP_LIMITS.expandedBytes) reject("limit_exceeded", "Working directory exceeds size limits");
      outputBytes += 76 + Buffer.byteLength(name, "utf8") * 2 + size;
      if (outputBytes > ZIP_LIMITS.archiveBytes) reject("limit_exceeded", "Repacked ZIP exceeds the file byte limit");
      entries.push({ name, absolute, stats });
      if (stats.isDirectory()) await walk(absolute, name);
    }
  }
  try {
    await walk(root, "");
    const packed: { name: string; bytes: Buffer }[] = [];
    for (const entry of entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      budget.check();
      // Check the ancestor chain again before reading. This is not an OS sandbox against same-UID races.
      await checkedDirectory(path.dirname(entry.absolute), budget);
      packed.push({ name: entry.name, bytes: entry.stats.isDirectory() ? Buffer.alloc(0) : await readWorkingFile(entry, budget) });
    }
    const result = packEntries(packed, budget);
    parseZip(result, budget); // Output must meet the same strict policy accepted on input.
    return result;
  } catch (error) {
    if (error instanceof ArchiveHelperError) throw error;
    throw new ArchiveHelperError("working_directory_changed", "Working directory could not be safely repacked", { cause: error });
  }
}
