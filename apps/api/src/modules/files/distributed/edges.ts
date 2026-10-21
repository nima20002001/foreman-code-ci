import { isDeepStrictEqual } from 'node:util'
import type { Readable } from 'node:stream'
import { ArtifactEdgeBindingSchema, ArtifactEdgeReadSchema, type ArtifactAttempt, type ArtifactGrantReference,
  type ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import { fileStateAt, parseAgentFileReadResult } from '@foreman-code/contracts/files'
import type { FileQuery, FileRepository } from '../repository.js'
import type { FileByteStorage } from '../storage.js'
import { fileScopeIdentity } from '../requests.js'
import { byteRange } from '../tools/transfers.js'
import { DomainError } from '../../errors.js'

/** Implementations lock current principal/grant, device, accepted attempt and root rows.
 * Source and destination checks use accepted sender/receiver grants, never uploader privileges.
 * All checks are required on retry and after I/O; hashes alone confer no authority. */
export interface ArtifactEdgeAuthorization {
  assertCurrent(binding: ArtifactEdgeBinding, query: FileQuery): Promise<void>
}
export interface ArtifactEdgeRepository {
  pin(binding: ArtifactEdgeBinding, authorize: (query: FileQuery) => Promise<void>): Promise<ArtifactEdgeBinding>
  read(edgeId: string): Promise<ArtifactEdgeBinding | undefined>
  recordRead(binding: ArtifactEdgeBinding, readAt: string, authorize: (query: FileQuery) => Promise<void>): Promise<void>
}
const same = isDeepStrictEqual
export class ArtifactEdgeService {
  constructor(private readonly edges: ArtifactEdgeRepository, private readonly files: FileRepository,
    private readonly bytes: FileByteStorage, private readonly authority: ArtifactEdgeAuthorization,
    private readonly clock: () => Date = () => new Date()) {}
  private async pinned(binding: ArtifactEdgeBinding) {
    const stored = await this.files.read(binding.pins.fileId, binding.pins.revisionId)
    if (!stored) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned artifact is unavailable.', 410)
    const { file, revision } = stored.value
    if (revision.sha256 !== binding.pins.sha256 || revision.byteSize !== binding.pins.byteSize
      || fileScopeIdentity(file.scope) !== fileScopeIdentity(binding.scope)) {
      throw new DomainError('FILE_EDGE_CONFLICT', 'The artifact does not match the accepted edge.', 409)
    }
    const state = fileStateAt(file, this.clock().toISOString())
    if (state !== 'ready') throw new DomainError('FILE_BYTES_UNAVAILABLE', `The pinned artifact is ${state}.`, 410)
    return stored
  }
  /** Only W08's main admission invokes this; there is no public pin/delegation endpoint. */
  async pinAccepted(raw: ArtifactEdgeBinding): Promise<ArtifactEdgeBinding> {
    const binding = ArtifactEdgeBindingSchema.parse(raw)
    await this.pinned(binding)
    return this.edges.pin(binding, async (query) => {
      await this.authority.assertCurrent(binding, query)
      // SQL repository rechecks lifecycle after authorization row-lock waits.
    })
  }
  async readAccepted(edgeId: string, consumer: ArtifactAttempt, authority: ArtifactGrantReference,
    offset: number, length: number) {
    const input = ArtifactEdgeReadSchema.parse({ edgeId, offset, length })
    const binding = await this.edges.read(input.edgeId)
    if (!binding || !same(binding.consumer, consumer) || !same(binding.receiver, authority)) {
      throw new DomainError('FILE_EDGE_DENIED', 'The caller does not own this accepted artifact input.', 403)
    }
    // A short metadata transaction authorizes before any disk I/O.
    await this.edges.pin(binding, (query) => this.authority.assertCurrent(binding, query))
    const stored = await this.pinned(binding)
    if (offset > stored.value.revision.byteSize) throw new DomainError('FILE_RANGE_INVALID', 'Offset exceeds pinned bytes.', 416)
    let stream: Readable | undefined
    let data: Buffer
    try {
      stream = await this.bytes.download(stored.storageKey, stored.value.revision)
      data = await byteRange(stream, offset, length)
    } finally { stream?.destroy() }
    if (data.length !== Math.min(length, binding.pins.byteSize - offset)) {
      throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned byte stream ended unexpectedly.', 410)
    }
    const readAt = this.clock().toISOString()
    // The second transaction reauthorizes both grants and lifecycle after verification/read.
    await this.edges.recordRead(binding, readAt, (query) => this.authority.assertCurrent(binding, query))
    const current = await this.pinned(binding)
    return parseAgentFileReadResult({ fileId: binding.pins.fileId, revisionId: binding.pins.revisionId, offset, length }, { status: 'ready', ...current.value,
      readAt, offset, byteLength: data.length, contentBase64: data.toString('base64'), eof: offset + data.length === binding.pins.byteSize })
  }
}
