import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { FileRevisionSchema, MAX_FILE_BYTES, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import type { FileByteStorage } from '../storage.js'
import type { FileToolSessions } from './context.js'
import { completedBytes } from './transfers.js'
import type { ArtifactSnapshot, AuthorizedFileCaller, FileToolArtifact, FileToolRepository, FileEditToolName } from './types.js'

type ArtifactPermission = 'files.create_working_copy' | 'files.publish_result' | FileEditToolName

const opaqueId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
const missing = () => new DomainError('FILE_ARTIFACT_NOT_FOUND', 'The artifact does not belong to this authenticated turn.', 404)

/** Runner-side handle registry. There is intentionally no API that opens a caller-supplied host path.
 * Every edit creates a new immutable byte object; mutable handle metadata is a compare-and-set pointer. */
export class FileToolArtifacts {
  constructor(private readonly repository: FileToolRepository, private readonly bytes: FileByteStorage,
    private readonly sessions: FileToolSessions, private readonly clock: () => Date = () => new Date()) {}

  async get(caller: AuthorizedFileCaller, artifactId: string): Promise<FileToolArtifact> {
    if (!opaqueId(artifactId)) throw missing()
    const artifact = await this.repository.artifact(caller.binding, artifactId)
    if (!artifact || artifact.binding !== caller.binding) throw missing()
    if (artifact.retiredAt) throw new DomainError('FILE_ARTIFACT_EXPIRED', 'This turn artifact is no longer available.', 410)
    return artifact
  }
  async completed(caller: AuthorizedFileCaller, artifactId: string): Promise<FileToolArtifact & { snapshot: ArtifactSnapshot }> {
    const artifact = await this.get(caller, artifactId)
    if (artifact.state !== 'complete' || !artifact.snapshot) throw new DomainError('FILE_ARTIFACT_INCOMPLETE', 'Complete the artifact write before publishing.', 409)
    return { ...artifact, snapshot: artifact.snapshot }
  }

  /** Read only an owned immutable artifact snapshot, never an execution-host path. */
  async readSnapshot(caller: AuthorizedFileCaller, artifactId: string,
    signal: AbortSignal): Promise<{ revision: ArtifactSnapshot['revision']; bytes: Buffer }> {
    const artifact = await this.get(caller, artifactId)
    if (artifact.state === 'writing' || !artifact.snapshot) {
      throw new DomainError('FILE_ARTIFACT_INCOMPLETE', 'The artifact has no available snapshot.', 409)
    }
    const { snapshot } = artifact
    const stream = await this.bytes.download(snapshot.storageKey, snapshot.revision)
    try {
      const data = await completedBytes(stream, MAX_FILE_BYTES, signal)
      if (data.length !== snapshot.revision.byteSize
        || createHash('sha256').update(data).digest('hex') !== snapshot.revision.sha256) {
        throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The artifact bytes do not match their revision.', 410)
      }
      return { revision: snapshot.revision, bytes: data }
    } finally { stream.destroy() }
  }

  /** Internal native-runner API. Accepted file mutation permission is mandatory. */
  async create(token: string, filename: string, mediaType: FileToolArtifact['mediaType'],
    source?: { ref: MessageAttachmentRef; sha256: string }, permission: ArtifactPermission = 'files.publish_result'): Promise<{ artifactId: string; writeId: string }> {
    const caller = await this.sessions.authenticate(token, permission)
    const now = this.clock().toISOString(), artifactId = randomUUID(), writeId = randomUUID()
    FileRevisionSchema.parse({ fileId: artifactId, revisionId: writeId, filename, mediaType,
      byteSize: 0, sha256: '0'.repeat(64), origin: 'agent_output', createdAt: now })
    await this.repository.createArtifact({ artifactId, writeId, binding: caller.binding, filename, mediaType,
      createdAt: now, state: 'writing', ...(source ? { source: source.ref, sourceSha256: source.sha256 } : {}) })
    return { artifactId, writeId }
  }

  async beginWrite(token: string, artifactId: string, baseRevisionId?: string,
    permission: ArtifactPermission = 'files.publish_result'): Promise<string> {
    const caller = await this.sessions.authenticate(token, permission)
    const artifact = await this.get(caller, artifactId)
    if (baseRevisionId !== undefined && artifact.snapshot?.revision.revisionId !== baseRevisionId) {
      throw new DomainError('FILE_WORKING_COPY_CONFLICT', 'The working copy has changed.', 409)
    }
    const writeId = randomUUID()
    if (!await this.repository.beginWrite(caller.binding, artifactId, writeId, baseRevisionId)) {
      if (baseRevisionId !== undefined) throw new DomainError('FILE_WORKING_COPY_CONFLICT', 'The working copy changed or another writer owns it.', 409)
      throw new DomainError('FILE_ARTIFACT_BUSY', 'An artifact write is already in progress.', 409)
    }
    return writeId
  }
  async abortWrite(token: string, artifactId: string, writeId: string): Promise<void> {
    const caller = await this.sessions.authenticate(token, 'files.publish_result')
    await this.get(caller, artifactId)
    await this.repository.failWrite(caller.binding, artifactId, writeId)
  }
  async completeWrite(token: string, artifactId: string, writeId: string, source: Readable,
    signal: AbortSignal = AbortSignal.timeout(120_000), permission: ArtifactPermission = 'files.publish_result'): Promise<void> {
    await this.commitWrite(token, artifactId, writeId, source, signal, permission)
  }
  /** Return this writer's exact commit, even if another writer starts before the response is sent. */
  async completeEdit(token: string, artifactId: string, writeId: string, source: Readable,
    permission: FileEditToolName): Promise<ArtifactSnapshot> {
    return this.commitWrite(token, artifactId, writeId, source, AbortSignal.timeout(120_000), permission)
  }
  private async commitWrite(token: string, artifactId: string, writeId: string, source: Readable,
    signal: AbortSignal, permission: ArtifactPermission): Promise<ArtifactSnapshot> {
    let caller: AuthorizedFileCaller | undefined
    try {
      caller = await this.sessions.authenticate(token, permission)
      const artifact = await this.get(caller, artifactId)
      if (artifact.writeId !== writeId || artifact.state === 'failed') throw new DomainError('FILE_ARTIFACT_WRITE_STALE', 'This writer no longer owns the artifact.', 409)
      const data = await completedBytes(source, MAX_FILE_BYTES, signal)
      const sha256 = createHash('sha256').update(data).digest('hex')
      if (artifact.state === 'complete') {
        if (artifact.snapshot?.revision.sha256 === sha256 && artifact.snapshot.revision.byteSize === data.length) {
          await this.sessions.authenticate(token, permission); return artifact.snapshot
        }
        throw new DomainError('FILE_REQUEST_CONFLICT', 'A completed writer cannot change its bytes.', 409)
      }
      const revision = FileRevisionSchema.parse({ fileId: artifactId, revisionId: randomUUID(),
        filename: artifact.filename, mediaType: artifact.mediaType, byteSize: data.length, sha256,
        origin: artifact.sourceSha256 === sha256 ? 'agent_copy' : 'agent_output', createdAt: this.clock().toISOString() })
      const storageKey = randomUUID()
      // The registry commit precedes all filesystem I/O. Failed writes, lost acknowledgements
      // and snapshots replaced by later edits remain discoverable after a process restart.
      if (!await this.repository.registerStorage(caller.binding, artifactId, writeId, storageKey)) {
        throw new DomainError('FILE_ARTIFACT_WRITE_STALE', 'A newer writer owns the artifact.', 409)
      }
      const candidate = await this.bytes.receive(storageKey, Readable.from([data]), revision, signal)
      try { await this.bytes.stage(candidate, revision); await this.bytes.finalize(storageKey, revision) }
      finally { await this.bytes.discard(candidate) }
      await this.sessions.authenticate(token, permission)
      if (!await this.repository.finishWrite(caller.binding, artifactId, writeId, { storageKey, revision })) {
        const current = await this.get(caller, artifactId)
        if (current.state === 'complete' && current.writeId === writeId && current.snapshot?.revision.sha256 === sha256
          && current.snapshot.revision.byteSize === data.length) return current.snapshot
        throw new DomainError('FILE_ARTIFACT_WRITE_STALE', 'A newer writer owns the artifact.', 409)
      }
      return { storageKey, revision }
    } catch (error) {
      if (caller && opaqueId(artifactId)) await this.repository.failWrite(caller.binding, artifactId, writeId)
      throw error
    } finally { source.destroy() }
  }
}
