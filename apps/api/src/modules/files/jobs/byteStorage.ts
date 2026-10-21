import type { FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { JobArtifactMediaTypeSchema } from '@foreman-code/contracts/job-artifacts'
import { DomainError } from '../../errors.js'
import { FileByteStorage } from '../storage.js'
import { readFileChunks, verifyFileType, type ExpectedFileBytes } from '../byteValidation.js'

/** CI has a distinct allowlisted capability, while sharing private immutable storage mechanics. */
export class CiOutputByteStorage extends FileByteStorage {
  protected override async verifyType(handle: FileHandle, expected: ExpectedFileBytes, maxBytes: number): Promise<void> {
    if (!('byteClass' in expected) || expected.byteClass !== 'ci-output') {
      throw new DomainError('FILE_BYTE_CLASS_DENIED', 'This capability accepts only declared CI output bytes.', 415)
    }
    JobArtifactMediaTypeSchema.parse(expected.mediaType)
    const invalid = (message: string): never => { throw new DomainError('JOB_ARTIFACT_TYPE_INVALID', message, 415) }
    if (expected.mediaType === 'application/octet-stream') return
    if (expected.mediaType === 'application/zip') {
      return verifyFileType(handle, { ...expected, mediaType: 'application/zip' }, maxBytes)
    }
    if (expected.mediaType === 'application/gzip') {
      // Validate stream/CRC and bound decompression without extracting any filename to disk.
      const source = Readable.from(readFileChunks(handle)), gunzip = createGunzip()
      source.on('error', error => gunzip.destroy(error))
      source.pipe(gunzip)
      let expanded = 0
      try {
        for await (const chunk of gunzip) {
          expanded += (chunk as Buffer).length
          if (expanded > expected.byteSize * 100 || expanded > 128 * 1024 * 1024) invalid('Gzip expansion exceeds the CI output budget.')
        }
      } catch (error) { if (error instanceof DomainError) throw error; invalid('Gzip bytes or checksum are invalid.') }
      finally { source.destroy(); gunzip.destroy() }
      return
    }
    const decoder = new TextDecoder('utf-8', { fatal: true }), json: string[] = []
    try {
      for await (const chunk of readFileChunks(handle)) {
        const text = decoder.decode(chunk, { stream: true })
        if (Array.from(text).some(char=>{const code=char.charCodeAt(0);return code===127 || (code<32 && ![9,10,13].includes(code))})) invalid('CI text contains unsupported control characters.')
        if (expected.mediaType === 'application/json') json.push(text)
      }
      const tail = decoder.decode()
      if (expected.mediaType === 'application/json') {
        json.push(tail); JSON.parse(json.join(''))
      }
    } catch (error) { if (error instanceof DomainError) throw error; invalid('CI text must be valid UTF-8; JSON must be syntactically valid.') }
  }
}
