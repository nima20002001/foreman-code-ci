import { Readable } from 'node:stream'
import {
  AgentFileListInputSchema, AgentFileListResultSchema, AgentFileReadInputSchema,
  AgentFileCreateWorkingCopyInputSchema, AgentFileCreateWorkingCopyResultSchema,
  AgentFilePublishInputSchema, AgentFilePublishResultSchema, FileWithRevisionSchema, FileRevisionSchema,
  MAX_FILE_BYTES, fileStateAt, parseAgentFileReadResult,
  type FileScope, type FileWithRevision, type MessageAttachmentRef,
} from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import { fileScopeIdentity } from '../requests.js'
import type { TemporaryFileService } from '../service.js'
import { digest, targetOf, type FileToolSessions } from './context.js'
import type { FileToolArtifacts } from './artifacts.js'
import { byteRange, completedBytes } from './transfers.js'
import { FileWorkingCopyEditor } from './workingCopyEdits.js'
import type { AuthorizedFileCaller, FileReferenceResolver, FileToolContext, FileToolRepository } from './types.js'

class Unavailable extends DomainError {
  constructor(readonly reason: 'pending' | 'expired' | 'removed' | 'not_found' | 'forbidden') {
    super('FILE_UNAVAILABLE', `The pinned file is ${reason}.`, reason === 'forbidden' ? 403 : reason === 'not_found' ? 404 : 410)
  }
}
const samePins = (value: FileWithRevision, ref: MessageAttachmentRef) => value.file.fileId === ref.fileId
  && value.revision.fileId === ref.fileId && value.revision.revisionId === ref.revisionId

export class AgentFileToolService {
  constructor(private readonly files: TemporaryFileService, readonly sessions: FileToolSessions,
    readonly artifacts: FileToolArtifacts, private readonly repository: FileToolRepository,
    private readonly references?: FileReferenceResolver, readonly clock: () => Date = () => new Date()) {}

  private scope(caller: AuthorizedFileCaller, scope: FileScope): void {
    if (scope.kind === 'job_execution') throw new Unavailable('forbidden')
    if (scope.kind === 'temporary') {
      if (fileScopeIdentity(scope) !== fileScopeIdentity(caller.context.scope)) throw new Unavailable('forbidden')
      return
    }
    const chat = caller.context.scope.chat
    if (chat.kind !== 'agent' || scope.workspaceId !== chat.workspaceId
      || (scope.kind === 'workflow_reference' && scope.workflowId !== chat.workflowId)) throw new Unavailable('forbidden')
  }
  private ready(value: FileWithRevision): void {
    const state = fileStateAt(value.file, this.clock().toISOString())
    if (state !== 'ready') throw new Unavailable(state)
  }
  private async metadata(caller: AuthorizedFileCaller, ref: MessageAttachmentRef): Promise<FileWithRevision> {
    const stored = await this.files.repository.read(ref.fileId, ref.revisionId)
    if (!stored) throw new Unavailable('not_found')
    const value = FileWithRevisionSchema.parse(stored.value)
    if (!samePins(value, ref)) throw new Unavailable('not_found')
    this.scope(caller, value.file.scope); this.ready(value)
    return value
  }
  private async open(caller: AuthorizedFileCaller, ref: MessageAttachmentRef): Promise<{ value: FileWithRevision; stream: Readable }> {
    const value = await this.metadata(caller, ref)
    if (value.file.scope.kind === 'temporary') {
      const { stream } = await this.files.download(caller.principal, targetOf(caller.context), ref)
      return { value, stream }
    }
    if (!this.references?.open) throw new DomainError('FILE_REFERENCE_RESOLVER_REQUIRED', 'Reference copies require a streaming resolver.', 409)
    const opened = await this.references.open(caller, ref)
    try {
      if (!samePins(opened.value, ref) || opened.value.file.scope.kind === 'temporary') throw new Unavailable('not_found')
      this.scope(caller, opened.value.file.scope); this.ready(opened.value)
      return opened
    } catch (error) { opened.stream.destroy(); throw error }
  }
  private async provenance(caller: AuthorizedFileCaller, ref: MessageAttachmentRef, readAt: string): Promise<void> {
    const chat = caller.context.scope.chat
    if (chat.kind === 'agent' && chat.runId && chat.executionId) {
      await this.repository.recordRead(caller.binding, { runId: chat.runId, executionId: chat.executionId, ...ref, readAt })
    }
  }

  async list(token: string, raw: unknown) {
    const caller = await this.sessions.authenticate(token, 'files.list')
    const input = AgentFileListInputSchema.parse(raw)
    if (input.scope.kind === 'job_execution') throw new Unavailable('forbidden')
    this.scope(caller, input.scope)
    let result
    const page = { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }
    if (input.scope.kind === 'temporary') result = await this.files.list(caller.principal, targetOf(caller.context), page)
    else {
      if (!this.references) throw new DomainError('FILE_REFERENCE_RESOLVER_REQUIRED', 'Reference manifests require the FIL-37 resolver.', 409)
      result = await this.references.list(caller, input.scope, page)
    }
    const parsed = AgentFileListResultSchema.parse(result)
    for (const item of parsed.items) {
      this.scope(caller, item.file.scope)
      if (item.file.scope.kind !== input.scope.kind) throw new DomainError('FILE_RESOLVER_INVALID', 'The manifest does not match its requested scope.', 500)
    }
    await this.sessions.authenticate(token, 'files.list')
    return parsed
  }

  async read(token: string, raw: unknown) {
    const caller = await this.sessions.authenticate(token, 'files.read')
    return this.readAuthorized(caller, raw, () => this.sessions.authenticate(token, 'files.read'))
  }

  /** Trusted admission-bound range reader. Rechecks grants and exact scope on every range. */
  async readAccepted(context: FileToolContext, raw: unknown) {
    const caller = await this.sessions.authorizeAccepted(context)
    return this.readAuthorized(caller, raw, () => this.sessions.authorizeAccepted(context))
  }

  private async readAuthorized(caller: AuthorizedFileCaller, raw: unknown,
    reauthorize: () => Promise<AuthorizedFileCaller>) {
    const input = AgentFileReadInputSchema.parse(raw)
    const ref = { fileId: input.fileId, revisionId: input.revisionId }
    try {
      const stored = await this.files.repository.read(ref.fileId, ref.revisionId)
      if (stored?.value.file.scope.kind === 'job_execution') throw new Unavailable('forbidden')
      if (stored && stored.value.file.scope.kind !== 'temporary') {
        if (!this.references) throw new DomainError('FILE_REFERENCE_RESOLVER_REQUIRED', 'Reference reads require the FIL-37 resolver.', 409)
        const result = await this.references.read(caller, input)
        await reauthorize()
        return parseAgentFileReadResult(input, result)
      }
      const opened = await this.open(caller, ref)
      let data: Buffer
      try {
        if (input.offset > opened.value.revision.byteSize) throw new DomainError('FILE_RANGE_INVALID', 'The offset exceeds the pinned revision length.', 416)
        data = await byteRange(opened.stream, input.offset, input.length)
      } finally { opened.stream.destroy() }
      const current = await reauthorize()
      // Re-read lifecycle metadata: removal/apply-to-existing retention may have changed during I/O.
      const value = await this.metadata(current, ref)
      if (data.length !== Math.min(input.length, opened.value.revision.byteSize - input.offset)) {
        throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned byte stream ended unexpectedly.', 410)
      }
      const readAt = this.clock().toISOString()
      const result = parseAgentFileReadResult(input, { status: 'ready', ...value, readAt,
        offset: input.offset, byteLength: data.length, contentBase64: data.toString('base64'),
        eof: input.offset + data.length === opened.value.revision.byteSize })
      await this.provenance(caller, ref, readAt)
      return result
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error
      return parseAgentFileReadResult(input, { status: 'unavailable', ref, reason: error.reason })
    }
  }

  async createWorkingCopy(token: string, raw: unknown) {
    const caller = await this.sessions.authenticate(token, 'files.create_working_copy')
    const input = AgentFileCreateWorkingCopyInputSchema.parse(raw)
    this.scope(caller, input.destination)
    const inputHash = digest(JSON.stringify([caller.binding, input.source.fileId, input.source.revisionId]))
    const existing = await this.repository.copyReceipt(caller.principal.id, input.commandId)
    if (existing && existing.inputHash !== inputHash) throw new DomainError('FILE_REQUEST_CONFLICT', 'commandId belongs to different copy input or context.', 409)
    // Replays still authorize the original pins and reject an expired/removed source.
    const opened = await this.open(caller, input.source)
    if (existing) {
      opened.stream.destroy()
      await this.artifacts.get(caller, existing.result.value.artifactId)
      return AgentFileCreateWorkingCopyResultSchema.parse({ ...existing.result, replayed: true })
    }
    const data = await completedBytes(opened.stream, MAX_FILE_BYTES)
    await this.metadata(await this.sessions.authenticate(token, 'files.create_working_copy'), input.source)
    const document = FileRevisionSchema.parse(opened.value.revision)
    const handle = await this.artifacts.create(token, document.filename, document.mediaType,
      { ref: input.source, sha256: opened.value.revision.sha256 }, 'files.create_working_copy')
    // Pass detached complete bytes, never a reference-storage hard link or a caller-supplied path.
    await this.artifacts.completeWrite(token, handle.artifactId, handle.writeId, Readable.from([data]),
      AbortSignal.timeout(120_000), 'files.create_working_copy')
    await this.metadata(await this.sessions.authenticate(token, 'files.create_working_copy'), input.source)
    await this.provenance(caller, input.source, this.clock().toISOString())
    const result = AgentFileCreateWorkingCopyResultSchema.parse({ value: { artifactId: handle.artifactId,
      source: input.source, destination: caller.context.scope, filename: opened.value.revision.filename,
      createdAt: this.clock().toISOString() }, replayed: false })
    const saved = await this.repository.saveCopyReceipt({ ownerPrincipalId: caller.principal.id, commandId: input.commandId, inputHash, result })
    return AgentFileCreateWorkingCopyResultSchema.parse({ ...saved.result, replayed: saved.result.value.artifactId !== handle.artifactId })
  }

  async writeWorkingCopy(token: string, raw: unknown) {
    return new FileWorkingCopyEditor(this.sessions, this.artifacts, this.files.bytes).write(token, raw)
  }

  async applyFormatEdit(token: string, raw: unknown) {
    return new FileWorkingCopyEditor(this.sessions, this.artifacts, this.files.bytes).apply(token, raw)
  }

  async publish(token: string, raw: unknown) {
    const caller = await this.sessions.authenticate(token, 'files.publish_result')
    const input = AgentFilePublishInputSchema.parse(raw)
    this.scope(caller, input.scope)
    const artifact = await this.artifacts.completed(caller, input.artifactId)
    if (artifact.mediaType !== input.mediaType) throw new DomainError('FILE_MEDIA_TYPE_MISMATCH', 'Publish the artifact in its verified media type.', 422)
    let sourceSha256: string | undefined
    if (artifact.source) {
      const source = await this.open(caller, artifact.source)
      sourceSha256 = source.value.revision.sha256; source.stream.destroy()
    }
    const { snapshot } = artifact
    const origin = sourceSha256 === snapshot.revision.sha256 ? 'agent_copy' : 'agent_output'
    // Frozen tool contracts call this commandId. FIL-03 calls the durable transport key requestId.
    const requestId = `fil05:publish:${digest(input.commandId)}`
    const identity = digest(JSON.stringify([caller.binding, artifact.artifactId,
      artifact.source?.fileId ?? null, artifact.source?.revisionId ?? null, snapshot.revision.sha256, snapshot.revision.byteSize]))
    const allocated = await this.files.allocateAgentResult(caller.principal, targetOf(caller.context), {
      requestId, filename: input.filename, mediaType: input.mediaType,
      byteSize: snapshot.revision.byteSize, sha256: snapshot.revision.sha256,
    }, origin, identity)
    await this.sessions.authenticate(token, 'files.publish_result')
    await this.repository.linkPublication({ ownerPrincipalId: caller.principal.id, requestId, binding: caller.binding,
      context: caller.context, ref: { fileId: allocated.value.file.fileId, revisionId: allocated.value.revision.revisionId },
      createdAt: this.clock().toISOString() })
    const stream = await this.files.bytes.download(snapshot.storageKey, snapshot.revision)
    try {
      await this.files.upload(caller.principal, targetOf(caller.context), requestId, stream, {
        signal: AbortSignal.timeout(120_000),
        reauthorize: async () => (await this.sessions.authenticate(token, 'files.publish_result')).principal,
      })
    } finally { stream.destroy() }
    const current = await this.sessions.authenticate(token, 'files.publish_result')
    if (artifact.source) { const source = await this.open(current, artifact.source); source.stream.destroy() }
    const finalized = await this.files.finalize(current.principal, targetOf(current.context), requestId)
    await this.sessions.authenticate(token, 'files.publish_result')
    return AgentFilePublishResultSchema.parse({ value: finalized.value, replayed: allocated.replayed })
  }

  /** Attachment adoption/readback seam. Pins survive expiry; pending or canceled attempts are excluded. */
  async publishedForTurn(token: string): Promise<MessageAttachmentRef[]> {
    const caller = await this.sessions.authenticate(token, 'files.list')
    return this.repository.publications(caller.binding)
  }
}
