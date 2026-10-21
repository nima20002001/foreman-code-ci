import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  AgentFileApplyFormatEditInputSchema, AgentFileWriteWorkingCopyInputSchema,
  AgentFileWorkingCopyEditResultSchema, MAX_FILE_WRITE_BYTES,
  type AgentFileFormatEdit, type FileMediaType,
} from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import type { FileByteStorage } from '../storage.js'
import type { FileToolArtifacts } from './artifacts.js'
import type { FileToolSessions } from './context.js'
import { completedBytes } from './transfers.js'
import type { ArtifactSnapshot, AuthorizedFileCaller, FileEditToolName, FileToolArtifact } from './types.js'

type WorkingCopy = FileToolArtifact & { snapshot: ArtifactSnapshot }
const unsupported = () => new DomainError('FILE_FORMAT_EDIT_UNSUPPORTED', 'That edit is not supported for this working copy.', 422)
const bounded = (bytes: Uint8Array): Buffer => {
  if (bytes.byteLength > MAX_FILE_WRITE_BYTES) throw new DomainError('FILE_SIZE_LIMIT', 'Working copy exceeds the byte limit.', 413)
  return Buffer.from(bytes)
}
async function scratch<T>(work: (directory: string) => Promise<T>): Promise<T> {
  // Private server-owned scratch only. No project directory, execution-host path or tool-supplied path.
  const root = await mkdtemp(path.join(tmpdir(), 'fil05-edit-'))
  try { return await work(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

/** All format work finishes before taking the writer CAS. Parse/helper failures leave the copy intact. */
async function formatEdit(mediaType: FileMediaType, data: Buffer, edit: AgentFileFormatEdit): Promise<Buffer> {
  if (edit.kind === 'append_text') {
    const format = mediaType === 'text/markdown' ? 'markdown' : mediaType === 'application/pdf' ? 'pdf'
      : mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'docx' : undefined
    if (!format) throw unsupported()
    const { editDocument } = await import('../formats/index.js')
    const result = format === 'docx'
      ? await scratch((scratchRoot) => editDocument({ format, bytes: data }, edit, { scratchRoot }))
      : await editDocument({ format, bytes: data }, edit)
    if (result.status !== 'ready') {
      const status = result.status === 'too_large' ? 413 : result.status === 'busy' || result.status === 'unavailable' ? 503
        : result.status === 'timeout' ? 504 : 422
      throw new DomainError(`FILE_FORMAT_${result.status.toUpperCase()}`, result.reason, status)
    }
    if (result.mediaType !== mediaType) throw unsupported()
    return bounded(result.bytes)
  }
  if (edit.kind === 'resize_image') {
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') throw unsupported()
    const { resizeImage, ImageHelperError } = await import('../images/index.js')
    try { return bounded((await resizeImage({ mediaType, bytes: data }, edit)).bytes) }
    catch (error) {
      if (!(error instanceof ImageHelperError)) throw error
      throw new DomainError(`FILE_IMAGE_${error.code.toUpperCase()}`, error.message,
        error.code === 'limit_exceeded' ? 413 : error.code === 'timeout' ? 504 : 422, undefined, { cause: error })
    }
  }
  if (mediaType !== 'application/zip') throw unsupported()
  const { listZip, extractZip, repackZip, ArchiveHelperError } = await import('../archives/index.js')
  try {
    // listZip validates ALL names/aliases/links. Only an exact existing regular entry can be replaced.
    const entry = listZip(data).find((item) => item.name === edit.entryName && item.kind === 'file')
    if (!entry) throw new DomainError('FILE_ZIP_ENTRY_NOT_FOUND', 'Choose an existing regular ZIP entry.', 422)
    const replacement = bounded(Buffer.from(edit.contentBase64, 'base64'))
    return await scratch(async (root) => {
      const extracted = await extractZip(data, root)
      if (!constants.O_NOFOLLOW) throw unsupported()
      const file = await open(path.join(extracted.workingDirectory, entry.name),
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
      try { await file.writeFile(replacement) } finally { await file.close() }
      return bounded(await repackZip(extracted.workingDirectory))
    })
  } catch (error) {
    if (!(error instanceof ArchiveHelperError)) throw error
    throw new DomainError(`FILE_ARCHIVE_${error.code.toUpperCase()}`, error.message,
      error.code === 'limit_exceeded' ? 413 : error.code === 'timeout' ? 504 : 422, undefined, { cause: error })
  }
}

/** API-managed artifact edits, independent of project filesystem writability. File mutation grants remain mandatory. */
export class FileWorkingCopyEditor {
  constructor(private readonly sessions: FileToolSessions, private readonly artifacts: FileToolArtifacts,
    private readonly bytes: FileByteStorage) {}

  private async target(caller: AuthorizedFileCaller, artifactId: string, baseRevisionId?: string): Promise<WorkingCopy> {
    const artifact = await this.artifacts.get(caller, artifactId)
    // A reference/file ID cannot resolve in this registry; generated-output handles are not working copies.
    if (!artifact.source) throw new DomainError('FILE_WORKING_COPY_REQUIRED', 'Create a temporary working copy first.', 422)
    if (!artifact.snapshot || artifact.state === 'writing') {
      throw new DomainError('FILE_ARTIFACT_INCOMPLETE', 'The working copy has no available completed snapshot.', 409)
    }
    if (baseRevisionId !== undefined && artifact.snapshot.revision.revisionId !== baseRevisionId) {
      throw new DomainError('FILE_WORKING_COPY_CONFLICT', 'The working copy has changed.', 409)
    }
    // A failed writer retains its previous immutable snapshot; a replacement can safely recover it.
    return { ...artifact, snapshot: artifact.snapshot }
  }
  private async replace(token: string, artifact: WorkingCopy, data: Buffer, permission: FileEditToolName) {
    const writeId = await this.artifacts.beginWrite(token, artifact.artifactId, artifact.snapshot.revision.revisionId, permission)
    const { revision } = await this.artifacts.completeEdit(token, artifact.artifactId, writeId, Readable.from([data]), permission)
    return AgentFileWorkingCopyEditResultSchema.parse({ artifactId: artifact.artifactId,
      revisionId: revision.revisionId, byteSize: revision.byteSize, sha256: revision.sha256 })
  }
  async write(token: string, raw: unknown) {
    const caller = await this.sessions.authenticate(token, 'files.write_working_copy')
    const input = AgentFileWriteWorkingCopyInputSchema.parse(raw)
    const artifact = await this.target(caller, input.artifactId, input.baseRevisionId)
    return this.replace(token, artifact, bounded(Buffer.from(input.contentBase64, 'base64')), 'files.write_working_copy')
  }
  async apply(token: string, raw: unknown) {
    const caller = await this.sessions.authenticate(token, 'files.apply_format_edit')
    const input = AgentFileApplyFormatEditInputSchema.parse(raw)
    const artifact = await this.target(caller, input.artifactId, input.baseRevisionId)
    const { snapshot } = artifact
    const stream = await this.bytes.download(snapshot.storageKey, snapshot.revision)
    let data: Buffer
    try { data = await completedBytes(stream, MAX_FILE_WRITE_BYTES) } finally { stream.destroy() }
    if (data.length !== snapshot.revision.byteSize || createHash('sha256').update(data).digest('hex') !== snapshot.revision.sha256) {
      throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The working snapshot bytes do not match their revision.', 410)
    }
    await this.sessions.authenticate(token, 'files.apply_format_edit')
    const edited = await formatEdit(artifact.mediaType, data, input.edit)
    // beginWrite reauthorizes and atomically checks the snapshot used by the helper, even without a caller guard.
    return this.replace(token, artifact, edited, 'files.apply_format_edit')
  }
}
