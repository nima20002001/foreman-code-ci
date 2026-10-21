import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  AgentFileReadInputSchema, ConversationFileUploadInputSchema, MAX_FILE_BYTES, parseAgentFileReadResult,
  FileUploadRequestSchema, DEFAULT_FILE_RETENTION_SECONDS, FileRetentionDurationSchema, FileWithRevisionSchema,
  MessageAttachmentRefSchema, fileStateAt, temporaryFileExpiresAt,
  type FileScope,
} from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { JobArtifactFileRevisionSchema, JobArtifactRetentionSchema } from '@foreman-code/contracts/job-artifacts'
import { z } from 'zod'
import { DomainError } from '../errors.js'
import type { FileAccess, FileConversation, FileConversationAuthorization } from './authorization.js'
import type { AllocationSession, FileAllocation, FileAllocationRepository, FileRepository, StoredFile,
  FileMutationContext, FileMutationSource, FileQuery } from './repository.js'
import { fileListInput, fileScopeIdentity } from './requests.js'
import type { FileByteStorage } from './storage.js'
import { decodeReferenceBytes, readReferenceRange } from './references/bytes.js'

export interface FileScopeAuthorization<Target> {
  resolve(principal: ManagementPrincipal, target: Target, access: FileAccess, query?: FileQuery): Promise<FileScope>
}

/** One validation/publication pipeline for conversation uploads and permanent references. */
export class FileStorageService<Target> {
  constructor(
    readonly repository: FileRepository & FileAllocationRepository,
    readonly bytes: FileByteStorage,
    protected readonly authorization: FileScopeAuthorization<Target>,
    /** Retention integration supplies the authenticated-owner preference adapter; absence means the contract default. */
    private readonly retentionForOwner: (ownerPrincipalId: string) => Promise<number> = async () => DEFAULT_FILE_RETENTION_SECONDS,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  protected now() { return this.clock().toISOString() }
  private matches(stored: StoredFile, scope: FileScope) {
    if (fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(scope)) {
      throw new DomainError('FILE_NOT_FOUND', 'The pinned file revision was not found in this scope.', 404)
    }
  }
  private async allocation(session: AllocationSession, scope: FileScope): Promise<FileAllocation> {
    const allocation = await session.read()
    if (!allocation) throw new DomainError('FILE_UPLOAD_NOT_FOUND', 'The upload was not found.', 404)
    this.matches(allocation.stored, scope)
    return allocation
  }
  private live(allocation: FileAllocation) {
    const state = fileStateAt(allocation.stored.value.file, this.now())
    if (allocation.state === 'canceled' || state === 'removed') throw new DomainError('FILE_UPLOAD_CANCELED', 'The upload was canceled.', 409)
    if (state === 'expired') throw new DomainError('FILE_EXPIRED', 'The file has expired.', 410)
  }
  private result(allocation: FileAllocation, replayed: boolean) {
    const value = allocation.stored.value
    return { value: FileWithRevisionSchema.parse({ ...value, file: { ...value.file, state: fileStateAt(value.file, this.now()) } }), replayed }
  }

  private mutation(principal: ManagementPrincipal, target: Target, scope: FileScope,
    source: FileMutationSource, guard?: FileMutationContext): FileMutationContext | undefined {
    if (scope.kind === 'temporary') return guard
    return { source, authorize: async (query) => {
      await guard?.authorize(query)
      const current = await this.authorization.resolve(principal, target, 'write', query)
      if (fileScopeIdentity(current) !== fileScopeIdentity(scope)) {
        throw new DomainError('FILE_SCOPE_CHANGED', 'The reference scope changed during the upload.', 409)
      }
    } }
  }

  async allocate(principal: ManagementPrincipal, target: Target, input: unknown, source: FileMutationSource = 'http') {
    return this.allocateWithOrigin(principal, target, input, 'upload', undefined, source)
  }

  /** Trusted FIL-05 seam, never bound to an HTTP input. Origin and identity are server-derived. */
  async allocateAgentResult(principal: ManagementPrincipal, target: Target, input: unknown,
    origin: 'agent_copy' | 'agent_output', publicationIdentity: string, commitAuthorization?: FileMutationContext) {
    if (!publicationIdentity || !['agent_copy', 'agent_output'].includes(origin)) {
      throw new DomainError('FILE_PUBLICATION_INVALID', 'A bound agent publication is required.', 400)
    }
    return this.allocateWithOrigin(principal, target, input, origin, publicationIdentity, 'http', commitAuthorization)
  }

  private async allocateWithOrigin(principal: ManagementPrincipal, target: Target, input: unknown,
    origin: 'upload' | 'agent_copy' | 'agent_output', publicationIdentity?: string, source: FileMutationSource = 'http', commitAuthorization?: FileMutationContext) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    if (origin !== 'upload' && scope.kind !== 'temporary') {
      throw new DomainError('FILE_REFERENCE_READ_ONLY', 'Agent results cannot be written to permanent reference files.', 403)
    }
    if (scope.kind === 'job_execution') throw new DomainError('FILE_BYTE_CLASS_DENIED', 'Job artifacts require the explicit CI publication service.', 403)
    const request = FileUploadRequestSchema.parse(input)
    const inputHash = createHash('sha256').update(JSON.stringify([fileScopeIdentity(scope), request.filename,
      request.mediaType, request.byteSize, request.sha256,
      // Keep existing human upload receipts byte-for-byte compatible.
      ...(origin === 'upload' ? [] : [origin, publicationIdentity])])).digest('hex')
    return this.repository.withAllocation(principal.id, request.requestId, async (session) => {
      const existing = await session.read()
      if (existing) {
        if (existing.inputHash !== inputHash) throw new DomainError('FILE_REQUEST_CONFLICT', 'requestId was already used for different file metadata or a different scope.', 409)
        this.matches(existing.stored, scope)
        return this.result(existing, true)
      }
      const build = (durationSeconds: number | undefined): FileAllocation => {
        const duration = durationSeconds === undefined ? undefined : FileRetentionDurationSchema.parse(durationSeconds)
        const now = this.now(), fileId = randomUUID(), revisionId = randomUUID()
        const value = FileWithRevisionSchema.parse({ file: { fileId, currentRevisionId: revisionId, scope,
          state: 'pending', createdAt: now, ...(duration === undefined ? {} : {
            retentionDurationSeconds: duration, expiresAt: temporaryFileExpiresAt(now, duration) }) },
        revision: { fileId, revisionId, filename: request.filename, mediaType: request.mediaType,
          byteSize: request.byteSize, sha256: request.sha256, origin, createdAt: now } })
        return { allocationId: randomUUID(), requestId: request.requestId, inputHash,
          state: 'allocated', stored: { value, ownerPrincipalId: principal.id, storageKey: randomUUID() } }
      }
      // Permanent references never carry retention. Temporary replays never consult today's
      // preference; production samples it under the owner lock through this allocation's commit.
      if (scope.kind === 'temporary' && session.createWithRetention) {
        return this.result(await session.createWithRetention(build), false)
      }
      const allocation = build(scope.kind === 'temporary' ? await this.retentionForOwner(principal.id) : undefined)
      await session.create(allocation)
      return this.result(allocation, false)
    }, this.mutation(principal, target, scope, source, commitAuthorization))
  }

  /** Trusted CI seam: accepted output spec/closure/owner authority must supply the commit guard. */
  async allocateJobOutput(principal: ManagementPrincipal, target: Target, input: unknown,
    publicationIdentity: string, retentionSeconds: number, guard: FileMutationContext) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    if (scope.kind !== 'job_execution' || !publicationIdentity || !guard) {
      throw new DomainError('FILE_JOB_BINDING_REQUIRED', 'An explicitly authorized job execution artifact is required.', 403)
    }
    const request = z.object({ requestId: z.string().min(1).max(200),
      filename: JobArtifactFileRevisionSchema.unwrap().shape.filename,
      mediaType: JobArtifactFileRevisionSchema.unwrap().shape.mediaType,
      sha256: JobArtifactFileRevisionSchema.unwrap().shape.sha256,
      byteSize: JobArtifactFileRevisionSchema.unwrap().shape.byteSize }).strict().parse(input)
    const duration = JobArtifactRetentionSchema.parse(retentionSeconds)
    const inputHash = createHash('sha256').update(JSON.stringify([fileScopeIdentity(scope), request.filename,
      request.mediaType, request.byteSize, request.sha256, publicationIdentity, duration])).digest('hex')
    return this.repository.withAllocation(principal.id, request.requestId, async session => {
      const prior = await session.read()
      if (prior) {
        if (prior.inputHash !== inputHash) throw new DomainError('FILE_REQUEST_CONFLICT', 'The job publication identity already has different bytes or scope.', 409)
        this.matches(prior.stored, scope)
        return this.result(prior, true)
      }
      const now = this.now(), fileId = randomUUID(), revisionId = randomUUID()
      const value = FileWithRevisionSchema.parse({ file: { fileId, currentRevisionId: revisionId, scope,
        state: 'pending', createdAt: now, retentionDurationSeconds: duration, expiresAt: temporaryFileExpiresAt(now, duration) },
      revision: { byteClass: 'ci-output', fileId, revisionId, filename: request.filename, mediaType: request.mediaType,
        sha256: request.sha256, byteSize: request.byteSize, origin: 'job_output', createdAt: now } })
      const allocation: FileAllocation = { allocationId: randomUUID(), requestId: request.requestId, inputHash,
        state: 'allocated', stored: { value, ownerPrincipalId: principal.id, storageKey: randomUUID() } }
      await session.create(allocation)
      return this.result(allocation, false)
    }, this.mutation(principal, target, scope, guard.source, guard))
  }

  async upload(principal: ManagementPrincipal, target: Target, requestId: string, source: Readable,
    options: { signal?: AbortSignal; reauthorize?: () => Promise<ManagementPrincipal>; source?: FileMutationSource; commitAuthorization?: FileMutationContext } = {}) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    const initial = await this.repository.withAllocation(principal.id, requestId, async (session) => {
      const allocation = await this.allocation(session, scope); this.live(allocation); return allocation
    }, this.mutation(principal, target, scope, options.source ?? 'http', options.commitAuthorization))
    // No pooled connection/transaction is held while reading the network body.
    const candidate = await this.bytes.receive(initial.stored.storageKey, source, initial.stored.value.revision, options.signal)
    try {
      const currentPrincipal = options.reauthorize ? await options.reauthorize() : principal
      if (currentPrincipal.id !== principal.id) throw new DomainError('AUTH_REQUIRED', 'Upload authentication changed.', 401)
      const currentScope = await this.authorization.resolve(currentPrincipal, target, 'write')
      this.matches(initial.stored, currentScope)
      return await this.repository.withAllocation(principal.id, requestId, async (session) => {
        const allocation = await this.allocation(session, currentScope); this.live(allocation)
        if (allocation.state === 'finalized') return this.result(allocation, true)
        await this.bytes.stage(candidate, allocation.stored.value.revision)
        return this.result(await session.setState('staged'), allocation.state === 'staged')
      }, this.mutation(currentPrincipal, target, currentScope, options.source ?? 'http', options.commitAuthorization))
    } finally { await this.bytes.discard(candidate) }
  }

  async finalize(principal: ManagementPrincipal, target: Target, requestId: string, source: FileMutationSource = 'http', commitAuthorization?: FileMutationContext) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    const mutation = this.mutation(principal, target, scope, source, commitAuthorization)
    const initial = await this.repository.withAllocation(principal.id, requestId, async session => {
      const allocation = await this.allocation(session, scope)
      this.live(allocation)
      return allocation
    }, mutation)
    if (initial.state === 'finalized') {
      const stream = await this.bytes.download(initial.stored.storageKey, initial.stored.value.revision)
      stream.destroy()
    } else {
      // Immutable bytes can be verified without occupying a database connection.
      await this.bytes.finalize(initial.stored.storageKey, initial.stored.value.revision)
    }
    const currentScope = await this.authorization.resolve(principal, target, 'write')
    this.matches(initial.stored, currentScope)
    return this.repository.withAllocation(principal.id, requestId, async session => {
      const allocation = await this.allocation(session, currentScope)
      this.live(allocation)
      if (allocation.allocationId !== initial.allocationId || allocation.inputHash !== initial.inputHash
        || allocation.stored.storageKey !== initial.stored.storageKey) {
        throw new DomainError('FILE_REQUEST_CONFLICT', 'The upload allocation changed during publication.', 409)
      }
      if (allocation.state === 'finalized') return this.result(allocation, true)
      return this.result(await session.setState('finalized'), false)
    }, this.mutation(principal, target, currentScope, source, commitAuthorization))
  }

  async list(principal: ManagementPrincipal, target: Target, query: unknown) {
    const scope = await this.authorization.resolve(principal, target, 'read')
    const input = fileListInput(scope, query)
    return this.repository.list(scope, { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }, this.now())
  }

  protected async readMetadata(principal: ManagementPrincipal, target: Target, pins: unknown) {
    const scope = await this.authorization.resolve(principal, target, 'read')
    const ref = MessageAttachmentRefSchema.parse(pins)
    const stored = await this.repository.read(ref.fileId, ref.revisionId)
    if (!stored) throw new DomainError('FILE_NOT_FOUND', 'The pinned file revision was not found in this scope.', 404)
    this.matches(stored, scope)
    return stored
  }

  async download(principal: ManagementPrincipal, target: Target, pins: unknown) {
    const stored = await this.readMetadata(principal, target, pins)
    const state = fileStateAt(stored.value.file, this.now())
    if (state === 'pending') throw new DomainError('FILE_NOT_READY', 'The upload has not been finalized.', 409)
    if (state !== 'ready') throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.', 410)
    const stream = await this.bytes.download(stored.storageKey, stored.value.revision)
    // Retention can be shortened while bytes are being verified. Re-read metadata
    // before returning a stream; do not authorize it using a stale expiry snapshot.
    try {
      const current = await this.repository.read(stored.value.file.fileId, stored.value.revision.revisionId)
      if (!current || fileStateAt(current.value.file, this.now()) !== 'ready') {
        throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.', 410)
      }
      this.matches(current, stored.value.file.scope)
    } catch (error) { stream.destroy(); throw error }
    return { revision: stored.value.revision, stream }
  }

  async cancel(principal: ManagementPrincipal, target: Target, requestId: string, source: FileMutationSource = 'http') {
    const scope = await this.authorization.resolve(principal, target, 'write')
    return this.repository.withAllocation(principal.id, requestId, async (session) => {
      const allocation = await this.allocation(session, scope)
      if (allocation.state === 'finalized' || allocation.stored.value.file.state === 'ready') {
        throw new DomainError('FILE_ALREADY_FINALIZED', 'Only unsent staging can be canceled; finalized files cannot be deleted through this route.', 409)
      }
      // Tombstone first. Retry also removes bytes after a crash or filesystem failure.
      const canceled = await session.setState('canceled')
      await this.bytes.removeUnsent(canceled.stored.storageKey)
      return this.result(canceled, allocation.state === 'canceled')
    }, this.mutation(principal, target, scope, source))
  }
}

/** Preserve FIL-03's public constructor and conversation-only authorization. */
export class TemporaryFileService extends FileStorageService<FileConversation> {
  constructor(repository: FileRepository & FileAllocationRepository, bytes: FileByteStorage,
    authorization: FileConversationAuthorization,
    retentionForOwner: (ownerPrincipalId: string) => Promise<number> = async () => DEFAULT_FILE_RETENTION_SECONDS,
    clock: () => Date = () => new Date()) {
    super(repository, bytes, authorization, retentionForOwner, clock)
  }

  async uploadInline(principal: ManagementPrincipal, raw: unknown, reauthorize: () => Promise<ManagementPrincipal>) {
    const { conversation, upload, contentBase64 } = ConversationFileUploadInputSchema.parse(raw)
    await this.authorization.resolve(principal, conversation, 'write')
    let bytes: Buffer
    try { bytes = decodeReferenceBytes(contentBase64, upload.byteSize, MAX_FILE_BYTES) }
    catch { throw new DomainError('FILE_CONTENT_INVALID', 'The content must be canonical base64 matching byteSize.', 422) }
    await this.allocate(principal, conversation, upload, 'mcp')
    return this.upload(principal, conversation, upload.requestId, Readable.from([bytes]),
      { source: 'mcp', signal: AbortSignal.timeout(120_000), reauthorize })
  }

  async read(principal: ManagementPrincipal, target: FileConversation, raw: unknown) {
    const input = AgentFileReadInputSchema.parse(raw)
    const ref = { fileId: input.fileId, revisionId: input.revisionId }
    const stored = await this.readMetadata(principal, target, ref)
    const unavailable = (state: string) => parseAgentFileReadResult(input,
      { status: 'unavailable', ref, reason: state })
    const state = fileStateAt(stored.value.file, this.now())
    if (state !== 'ready') return unavailable(state)
    if (input.offset > stored.value.revision.byteSize) {
      throw new DomainError('FILE_RANGE_INVALID', 'The offset is outside this immutable revision.', 416)
    }
    let stream: Readable
    try { stream = await this.bytes.download(stored.storageKey, stored.value.revision, input) }
    catch (error) {
      if (error instanceof DomainError && error.code === 'FILE_BYTES_UNAVAILABLE') return unavailable('not_found')
      throw error
    }
    const bytes = await readReferenceRange(stream, 0, input.length, stored.value.revision.byteSize - input.offset)
    const current = await this.readMetadata(principal, target, ref)
    const readAt = this.now()
    const currentState = fileStateAt(current.value.file, readAt)
    if (currentState !== 'ready') return unavailable(currentState)
    return parseAgentFileReadResult(input, { status: 'ready', ...current.value, readAt,
      offset: input.offset, byteLength: bytes.length, contentBase64: bytes.toString('base64'),
      eof: input.offset + bytes.length === current.value.revision.byteSize })
  }

}
