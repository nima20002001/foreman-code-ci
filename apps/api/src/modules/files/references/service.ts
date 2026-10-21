import { Readable } from 'node:stream'
import {
  AgentFileReadInputSchema, FileWithRevisionSchema, MAX_FILE_BYTES,
  PermanentFileScopeSchema, parseAgentFileReadResult, type PermanentFileScope,
} from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import type { FileMutationSource, FileReferenceRepository } from '../repository.js'
import { fileScopeIdentity } from '../requests.js'
import { FileStorageService, type FileScopeAuthorization } from '../service.js'
import type { FileByteStorage } from '../storage.js'
import { decodeReferenceBytes, readReferenceRange } from './bytes.js'
import { FileReferenceAddInputSchema, FileReferenceRemoveInputSchema } from '@foreman-code/contracts/files'

export class FileReferenceService extends FileStorageService<PermanentFileScope> {
  constructor(private readonly references: FileReferenceRepository, bytes: FileByteStorage,
    authorization: FileScopeAuthorization<PermanentFileScope>,
    private readonly commands: Pick<PostgresCommandCoordinator, 'execute'>,
    clock: () => Date = () => new Date()) {
    // Permanent allocation never reads a temporary retention preference.
    super(references, bytes, authorization, undefined, clock)
  }

  /** Complete MCP add: uses exactly the HTTP allocation/verification/publication pipeline. */
  async add(principal: ManagementPrincipal, raw: unknown) {
    const input = FileReferenceAddInputSchema.parse(raw)
    await this.authorization.resolve(principal, input.scope, 'write')
    let bytes: Buffer
    try { bytes = decodeReferenceBytes(input.contentBase64, input.upload.byteSize, MAX_FILE_BYTES) }
    catch { throw new DomainError('FILE_CONTENT_INVALID', 'The content must be canonical base64 matching byteSize.', 422) }
    const allocated = await this.allocate(principal, input.scope, input.upload, 'mcp')
    await this.upload(principal, input.scope, input.upload.requestId, Readable.from([bytes]),
      { source: 'mcp', signal: AbortSignal.timeout(120_000) })
    const finalized = await this.finalize(principal, input.scope, input.upload.requestId, 'mcp')
    // A recovered pending allocation is still an add performed by this call, not a ready replay.
    return { ...finalized, replayed: allocated.replayed && allocated.value.file.state === 'ready' }
  }

  /** Operator read uses the frozen bounded/pinned byte result; it does not resolve agent access. */
  async read(principal: ManagementPrincipal, target: PermanentFileScope, raw: unknown) {
    const input = AgentFileReadInputSchema.parse(raw)
    const ref = { fileId: input.fileId, revisionId: input.revisionId }
    const stored = await this.readMetadata(principal, target, ref)
    if (stored.value.file.state !== 'ready') {
      return parseAgentFileReadResult(input, { status: 'unavailable', ref, reason: stored.value.file.state })
    }
    if (input.offset > stored.value.revision.byteSize) {
      throw new DomainError('FILE_RANGE_INVALID', 'The offset is outside this immutable revision.', 416)
    }
    let stream: Readable
    try { stream = await this.bytes.download(stored.storageKey, stored.value.revision, input) }
    catch (error) {
      if (error instanceof DomainError && error.code === 'FILE_BYTES_UNAVAILABLE') {
        return parseAgentFileReadResult(input, { status: 'unavailable', ref, reason: 'not_found' })
      }
      throw error
    }
    const bytes = await readReferenceRange(stream, 0, input.length, stored.value.revision.byteSize - input.offset)
    return parseAgentFileReadResult(input, { status: 'ready', ...stored.value, readAt: this.now(),
      offset: input.offset, byteLength: bytes.length, contentBase64: bytes.toString('base64'),
      eof: input.offset + bytes.length === stored.value.revision.byteSize })
  }

  async remove(principal: ManagementPrincipal, target: PermanentFileScope, raw: unknown, source: FileMutationSource = 'http') {
    const input = FileReferenceRemoveInputSchema.parse(raw)
    const scope = PermanentFileScopeSchema.parse(await this.authorization.resolve(principal, target, 'write'))
    const ref = { fileId: input.fileId, revisionId: input.revisionId }
    return this.commands.execute({ principal, source, operation: 'reference_file.remove', commandId: input.commandId,
      targetKey: `file:${input.fileId}`, payload: { scope, ...input },
      replayResult: (value) => FileWithRevisionSchema.parse(value),
      authorize: async (query) => {
        const current = await this.authorization.resolve(principal, target, 'write', query)
        if (fileScopeIdentity(current) !== fileScopeIdentity(scope)) {
          throw new DomainError('FILE_SCOPE_CHANGED', 'The reference scope changed during removal.', 409)
        }
      },
      // No byte deletion races: retain immutable objects, but deny all subsequent new reads.
      // Permanent byte reclamation is separate from temporary expiry and is not introduced here.
      perform: (query) => this.references.removeReference(scope, ref, query),
    })
  }
}
