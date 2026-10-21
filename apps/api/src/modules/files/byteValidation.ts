import type { FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import type { z } from 'zod'
import type { JobArtifactFileRevisionSchema } from '@foreman-code/contracts/job-artifacts'
import type { FileRevision } from '@foreman-code/contracts/files'

import { DomainError } from '../errors.js'

export type DocumentExpectedFileBytes = Pick<FileRevision, 'filename' | 'mediaType' | 'byteSize' | 'sha256'>
export type CiExpectedFileBytes = Pick<z.infer<typeof JobArtifactFileRevisionSchema>, 'byteClass' | 'filename' | 'mediaType' | 'byteSize' | 'sha256'>
export type ExpectedFileBytes = DocumentExpectedFileBytes | CiExpectedFileBytes
/** Archive processing never extracts to disk and bounds both compressed and expanded work. */
export const FILE_ARCHIVE_LIMITS = Object.freeze({ entries: 1000, expansionRatio: 100, xmlBytes: 1024 * 1024 })
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crcUpdate(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return crc >>> 0
}
function invalid(message = 'The bytes do not match the declared file type.'): never {
  throw new DomainError('FILE_TYPE_INVALID', message, 415)
}
async function at(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset)
    if (!result.bytesRead) invalid('The file is truncated.')
    offset += result.bytesRead
  }
  return bytes
}
/** Explicit-position reads never transfer ownership of the caller's file descriptor. */
export async function* readFileChunks(handle: FileHandle, start = 0, length?: number): AsyncGenerator<Buffer> {
  const count = length ?? (await handle.stat()).size - start
  for (let offset = 0; offset < count; offset += 65536) {
    yield await at(handle, start + offset, Math.min(65536, count - offset))
  }
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return invalid('Text must use valid UTF-8.') }
}

async function png(handle: FileHandle, size: number): Promise<void> {
  let position = 8, imageData = false, header = false
  while (position + 12 <= size) {
    const chunk = await at(handle, position, 8)
    const length = chunk.readUInt32BE(0), kind = chunk.toString('ascii', 4, 8)
    if (length > size - position - 12 || !/^[A-Za-z]{4}$/.test(kind)) invalid()
    if (!header && (kind !== 'IHDR' || length !== 13)) invalid()
    if (kind === 'IHDR') {
      if (header || length !== 13) invalid()
      const dimensions = await at(handle, position + 8, 13)
      if (!dimensions.readUInt32BE(0) || !dimensions.readUInt32BE(4)) invalid()
      header = true
    }
    let crc = crcUpdate(0xffffffff, chunk.subarray(4))
    for (let offset = 0; offset < length; offset += 65536) {
      crc = crcUpdate(crc, await at(handle, position + 8 + offset, Math.min(65536, length - offset)))
    }
    if (((crc ^ 0xffffffff) >>> 0) !== (await at(handle, position + 8 + length, 4)).readUInt32BE(0)) invalid('PNG checksum failed.')
    position += length + 12
    if (kind === 'IDAT') imageData = true
    if (kind === 'IEND') { if (length || !imageData || position !== size) invalid(); return }
  }
  invalid()
}
async function gif(handle: FileHandle, size: number): Promise<void> {
  const header = await at(handle, 0, 13)
  if (!header.readUInt16LE(6) || !header.readUInt16LE(8)) invalid()
  let position = 13 + (header[10]! & 0x80 ? 3 * 2 ** ((header[10]! & 7) + 1) : 0)
  let imageData = false
  const blocks = async () => {
    for (;;) {
      if (position >= size) invalid()
      const length = (await at(handle, position++, 1))[0]!
      if (!length) return
      position += length
      if (position > size) invalid()
    }
  }
  while (position < size) {
    const marker = (await at(handle, position++, 1))[0]!
    if (marker === 0x3b) { if (!imageData || position !== size) invalid(); return }
    if (marker === 0x21) { position++; await blocks(); continue }
    if (marker !== 0x2c || position + 9 >= size) invalid()
    const descriptor = await at(handle, position, 9)
    if (!descriptor.readUInt16LE(4) || !descriptor.readUInt16LE(6)) invalid()
    position += 9 + (descriptor[8]! & 0x80 ? 3 * 2 ** ((descriptor[8]! & 7) + 1) : 0)
    const codeSize = (await at(handle, position++, 1))[0]!
    if (codeSize < 2 || codeSize > 8) invalid()
    await blocks(); imageData = true
  }
  invalid()
}
async function webp(handle: FileHandle, size: number): Promise<void> {
  const header = await at(handle, 0, 12)
  if (header.readUInt32LE(4) + 8 !== size) invalid()
  let position = 12, imageData = false
  while (position + 8 <= size) {
    const chunk = await at(handle, position, 8)
    const name = chunk.toString('ascii', 0, 4), length = chunk.readUInt32LE(4)
    if (length > size - position - 8) invalid()
    if (['VP8 ', 'VP8L', 'ANMF'].includes(name) && length) imageData = true
    position += 8 + length + (length & 1)
  }
  if (!imageData || position !== size) invalid()
}
function binaryControls(text: string, allowWhitespace = false): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code === 127 || (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code)))) return true
  }
  return false
}
function safeArchiveName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes(':')
    || binaryControls(name)
    || name.replace(/\/$/, '').split('/').some((part) => !part || part === '.' || part === '..')) {
    invalid('Archive member paths must be relative and contain no traversal or control characters.')
  }
}
function extraFields(bytes: Buffer): void {
  let offset = 0
  while (offset + 4 <= bytes.length) {
    const id = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2)
    // Alternate filename metadata must not change the path that was checked above.
    if (id === 1 || id === 0x7075 || offset + 4 + length > bytes.length) invalid('ZIP64 and alternate archive paths are not supported.')
    offset += 4 + length
  }
  if (offset !== bytes.length) invalid()
}
async function archive(handle: FileHandle, expected: DocumentExpectedFileBytes, maxBytes: number): Promise<void> {
  const size = expected.byteSize
  if (size < 22) invalid()
  const tail = await at(handle, Math.max(0, size - 65557), Math.min(size, 65557))
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
  }
  if (end < 0) invalid('The ZIP directory is missing or truncated.')
  const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directory = tail.readUInt32LE(end + 16)
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count
    || count > FILE_ARCHIVE_LIMITS.entries || directory + directorySize !== size - tail.length + end) invalid('Unsupported or excessive ZIP directory.')
  const names = new Set<string>(), ranges: Array<[number, number]> = []
  const xml = new Map<string, string>()
  const requiredXml = new Set(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
  const docx = expected.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  let position = directory, expanded = 0
  for (let i = 0; i < count; i++) {
    if (position + 46 > directory + directorySize) invalid()
    const central = await at(handle, position, 46)
    if (central.readUInt32LE(0) !== 0x02014b50) invalid()
    const flags = central.readUInt16LE(8), method = central.readUInt16LE(10), crc = central.readUInt32LE(16)
    const compressed = central.readUInt32LE(20), uncompressed = central.readUInt32LE(24)
    const nameLength = central.readUInt16LE(28), extraLength = central.readUInt16LE(30), commentLength = central.readUInt16LE(32)
    const localPosition = central.readUInt32LE(42), fileType = (central.readUInt32LE(38) >>> 16) & 0xf000
    if ((flags & ~0x080e) || ![0, 8].includes(method) || central.readUInt16LE(34)
      || ![0, 0x8000, 0x4000].includes(fileType) || !nameLength || nameLength > 1024
      || uncompressed > maxBytes || expanded + uncompressed > maxBytes
      || uncompressed > Math.max(1, compressed) * FILE_ARCHIVE_LIMITS.expansionRatio
      || (method === 0 && compressed !== uncompressed)
      || position + 46 + nameLength + extraLength + commentLength > directory + directorySize) {
      invalid('Archive encryption, links, unsupported compression, or excessive expansion is not allowed.')
    }
    const nameBytes = await at(handle, position + 46, nameLength)
    if (!(flags & 0x0800) && nameBytes.some((byte) => byte > 127)) invalid('Non-ASCII archive names must declare UTF-8.')
    const name = utf8(nameBytes)
    safeArchiveName(name)
    if (names.has(name.toLowerCase())) invalid('Archive member names must be unique.')
    names.add(name.toLowerCase())
    if ((fileType === 0x4000 || name.endsWith('/')) && uncompressed !== 0) invalid()
    if (docx && /(?:vbaproject\.bin|\/activex\/|\/embeddings\/)/i.test(name)) invalid('Active or embedded Office packages are not accepted as DOCX.')
    extraFields(await at(handle, position + 46 + nameLength, extraLength))
    position += 46 + nameLength + extraLength + commentLength
    if (localPosition + 30 > directory) invalid()
    const local = await at(handle, localPosition, 30)
    const localExtra = local.readUInt16LE(28)
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags
      || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameLength
      || localPosition + 30 + nameLength + localExtra > directory
      || !(await at(handle, localPosition + 30, nameLength)).equals(nameBytes)) invalid('ZIP local and central metadata differ.')
    extraFields(await at(handle, localPosition + 30 + nameLength, localExtra))
    const dataStart = localPosition + 30 + nameLength + localExtra, dataEnd = dataStart + compressed
    if (dataEnd > directory) invalid()
    let rangeEnd = dataEnd
    if (flags & 8) {
      if (dataEnd + 12 > directory) invalid()
      const hasSignature = (await at(handle, dataEnd, 4)).readUInt32LE(0) === 0x08074b50
      rangeEnd += hasSignature ? 16 : 12
      if (rangeEnd > directory) invalid()
      const descriptor = await at(handle, dataEnd + (hasSignature ? 4 : 0), 12)
      if (descriptor.readUInt32LE(0) !== crc || descriptor.readUInt32LE(4) !== compressed || descriptor.readUInt32LE(8) !== uncompressed) invalid()
      if ((local.readUInt32LE(14) && local.readUInt32LE(14) !== crc)
        || (local.readUInt32LE(18) && local.readUInt32LE(18) !== compressed)
        || (local.readUInt32LE(22) && local.readUInt32LE(22) !== uncompressed)) invalid()
    } else if (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== uncompressed) invalid()
    ranges.push([localPosition, rangeEnd])
    const source = Readable.from(readFileChunks(handle, dataStart, compressed))
    const inflater = method === 8 ? createInflateRaw() : undefined
    // pipe() does not forward source errors to the destination.
    if (inflater) source.on('error', (error) => inflater.destroy(error))
    const stream = inflater ? source.pipe(inflater) : source
    let length = 0, checksum = 0xffffffff
    const chunks: Buffer[] = []
    try {
      for await (const raw of stream) {
        const chunk = Buffer.from(raw as Uint8Array)
        length += chunk.length
        if (length > uncompressed || expanded + length > maxBytes) invalid('Archive expansion exceeds its declared limit.')
        checksum = crcUpdate(checksum, chunk)
        if (docx && requiredXml.has(name)) {
          if (length > FILE_ARCHIVE_LIMITS.xmlBytes) invalid('DOCX structural XML exceeds its validation bound.')
          chunks.push(chunk)
        }
      }
    } catch (error) {
      if (error instanceof DomainError) throw error
      invalid('Compressed archive data is invalid.')
    } finally { source.destroy(); inflater?.destroy() }
    if ((inflater && inflater.bytesWritten !== compressed) || length !== uncompressed || ((checksum ^ 0xffffffff) >>> 0) !== crc) invalid('Archive size or CRC verification failed.')
    expanded += length
    if (docx && requiredXml.has(name)) xml.set(name, utf8(Buffer.concat(chunks)))
  }
  ranges.sort((a, b) => a[0] - b[0])
  let covered = 0
  for (const [start, endOfMember] of ranges) { if (start !== covered) invalid('Archive members overlap or contain hidden data.'); covered = endOfMember }
  if (position !== directory + directorySize || covered !== directory) invalid()
  if (docx) {
    if ([...requiredXml].some((name) => !xml.has(name))
      || !xml.get('[Content_Types].xml')!.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
      || !/<(?:[A-Za-z_][\w.-]*:)?document(?:\s|>)/.test(xml.get('word/document.xml')!)
      || !xml.get('_rels/.rels')!.includes('relationships/officeDocument')
      || [...xml.values()].some((text) => /<!DOCTYPE|<!ENTITY/i.test(text))) invalid('The archive is not a supported DOCX document.')
  }
}

/** Type/structure validation, not malware scanning, PDF sanitization, or full image/Office decoding. */
export async function verifyFileType(handle: FileHandle, expected: DocumentExpectedFileBytes, maxBytes: number): Promise<void> {
  if (expected.mediaType === 'text/markdown') {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      for await (const chunk of readFileChunks(handle)) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true })
        if (binaryControls(text, true)) invalid('Markdown contains binary control characters.')
      }
      decoder.decode()
    } catch (error) { if (error instanceof DomainError) throw error; invalid('Markdown must use valid UTF-8.') }
    return
  }
  const head = await at(handle, 0, Math.min(expected.byteSize, 16))
  const size = expected.byteSize
  switch (expected.mediaType) {
    case 'image/png':
      if (size < 57 || !head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid()
      return png(handle, size)
    case 'image/gif':
      if (size < 14 || !['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) invalid()
      return gif(handle, size)
    case 'image/jpeg':
      if (size < 8 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff
        || !(await at(handle, size - 2, 2)).equals(Buffer.from([0xff, 0xd9]))) invalid()
      return
    case 'image/webp':
      if (size < 20 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') invalid()
      return webp(handle, size)
    case 'application/pdf': {
      if (size < 16 || !/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(head.toString('ascii'))) invalid()
      const tail = await at(handle, Math.max(0, size - 1024), Math.min(size, 1024))
      if (!/%%EOF[\t\r\n ]*$/.test(tail.toString('latin1'))) invalid()
      return
    }
    case 'application/zip':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return archive(handle, expected, maxBytes)
    default: invalid()
  }
}
