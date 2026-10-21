import type { Readable } from 'node:stream'
import { FileRevisionSchema } from '@foreman-code/contracts/files'
import type { AgentFileReadInput, AgentFileReadResult, FileWithRevision, PermanentFileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../../errors.js'
import type { FileQuery, FileRepository } from '../repository.js'
import type { FileByteStorage } from '../storage.js'
import { readReferenceRange } from './bytes.js'
import { decodeReferenceCursor, effectiveReference, encodeReferenceCursor, referenceContextKey, referenceCursorKey } from './agentLineage.js'
import type { AgentReferenceAuthorization, AgentReferenceContext, AgentReferenceManifest,
  AgentReferenceManifestEntry, AgentReferencePageInput, AgentReferenceSubject, ReferenceReadRepository } from './agentTypes.js'

export interface AgentReferenceDependencies {
  authorization: AgentReferenceAuthorization
  files: Pick<FileRepository, 'list' | 'read'>
  bytes: Pick<FileByteStorage, 'download'>
  reads: ReferenceReadRepository
  clock?: () => Date
}
export interface AgentReferenceLimits { maxPageSize: number; maxReadBytes: number; maxFileBytes: number }

function pinConflict(): never {
  throw new DomainError('FILE_REFERENCE_PIN_CONFLICT', 'This Run already read a different immutable revision of this file.', 409)
}
function compact(context: AgentReferenceContext, row: FileWithRevision): AgentReferenceManifestEntry {
  if (!effectiveReference(context, row.file.scope) || (row.file.scope.kind === 'temporary' || row.file.scope.kind === 'job_execution')
    || row.file.state === 'expired' || row.file.fileId !== row.revision.fileId) {
    throw new DomainError('FILE_REFERENCE_METADATA_INVALID', 'Reference metadata does not match its authorized scope.', 500)
  }
  const { fileId, revisionId, filename, mediaType, byteSize } = FileRevisionSchema.parse(row.revision)
  return { fileId, revisionId, filename, mediaType, byteSize, scope: row.file.scope, state: row.file.state }
}

/** Domain implementation behind AgentReferenceService's strict frozen-schema boundary.
 * Injected storage is FIL-03 storage, never a runner path. There are deliberately no write methods. */
export class AgentReferenceAccess {
  constructor(private readonly dependencies: AgentReferenceDependencies, private readonly limits: AgentReferenceLimits) {}

  private now(): string { return (this.dependencies.clock ?? (() => new Date()))().toISOString() }

  private async reauthorize(principal: ManagementPrincipal, subject: AgentReferenceSubject,
    context: AgentReferenceContext, query?: FileQuery) {
    const current = await this.dependencies.authorization.resolve(principal, subject, query)
    if (!current || referenceContextKey(current) !== referenceContextKey(context)) {
      throw new DomainError('FILE_REFERENCE_CONTEXT_CHANGED', 'The reference caller changed during the read.', 409)
    }
  }

  async list(principal: ManagementPrincipal, subject: AgentReferenceSubject,
    input: AgentReferencePageInput): Promise<AgentReferenceManifest> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > this.limits.maxPageSize) {
      throw new DomainError('FILE_PAGE_INVALID', 'The reference page limit is invalid.', 400)
    }
    const context = await this.dependencies.authorization.resolve(principal, subject)
    if (!context) return { items: [], pageInfo: { nextCursor: null } }
    const key = referenceCursorKey(principal.id, context)
    const cursor = decodeReferenceCursor(input.cursor, key)
    const scopes: readonly PermanentFileScope[] = [
      { kind: 'workflow_reference', workspaceId: context.workspaceId, workflowId: context.workflowId },
      { kind: 'workspace_reference', workspaceId: context.workspaceId },
    ]
    const rows: FileWithRevision[] = []
    let nextCursor: string | null = null
    // At most two exact-scope repository pages per call. No unbounded scan or name-based deduplication.
    for (let phase = cursor.phase; phase <= 1; phase++) {
      const page = await this.dependencies.files.list(scopes[phase]!, {
        limit: input.limit - rows.length,
        ...(phase === cursor.phase && cursor.cursor !== undefined ? { cursor: cursor.cursor } : {}),
      }, this.now())
      if (page.items.length > input.limit - rows.length) throw new Error('Reference repository exceeded its page bound.')
      for (const row of page.items) {
        if (row.file.scope.kind !== scopes[phase]!.kind || !effectiveReference(context, row.file.scope)) {
          throw new DomainError('FILE_REFERENCE_METADATA_INVALID', 'Reference metadata escaped its exact list scope.', 500)
        }
      }
      rows.push(...page.items)
      if (page.pageInfo.nextCursor) {
        nextCursor = encodeReferenceCursor(key, { phase: phase as 0 | 1, cursor: page.pageInfo.nextCursor })
        break
      }
      if (rows.length === input.limit) {
        // A full workflow page may be followed by an empty final workspace page. Both calls stay bounded.
        if (phase === 0) nextCursor = encodeReferenceCursor(key, { phase: 1 })
        break
      }
    }
    const pins = context.runId ? await this.dependencies.reads.pinned(context.runId, rows.map((row) => row.file.fileId))
      : new Map<string, string>()
    const items: AgentReferenceManifestEntry[] = []
    for (const row of rows) {
      const pinned = pins.get(row.file.fileId)
      const value = pinned && pinned !== row.revision.revisionId
        ? (await this.dependencies.files.read(row.file.fileId, pinned))?.value : row
      if (!value || value.file.fileId !== row.file.fileId || (pinned && value.revision.revisionId !== pinned)) {
        throw new DomainError('FILE_REFERENCE_METADATA_UNAVAILABLE', 'The Run\'s pinned reference metadata is unavailable.', 503)
      }
      items.push(compact(context, value))
    }
    await this.reauthorize(principal, subject, context)
    return { items, pageInfo: { nextCursor } }
  }

  async read(principal: ManagementPrincipal, subject: AgentReferenceSubject,
    input: AgentFileReadInput): Promise<AgentFileReadResult> {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > this.limits.maxFileBytes
      || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > this.limits.maxReadBytes) {
      throw new DomainError('FILE_RANGE_INVALID', 'The reference range is invalid.', 416)
    }
    const ref = { fileId: input.fileId, revisionId: input.revisionId }
    const unavailable = (reason: 'pending' | 'removed' | 'not_found'): AgentFileReadResult => ({ status: 'unavailable', ref, reason })
    const context = await this.dependencies.authorization.resolve(principal, subject)
    // Do not even probe file existence for a global Operator conversation.
    if (!context) return unavailable('not_found')
    const stored = await this.dependencies.files.read(ref.fileId, ref.revisionId)
    if (!stored || !effectiveReference(context, stored.value.file.scope)) return unavailable('not_found')
    const { file, revision } = stored.value
    if (file.fileId !== ref.fileId || revision.fileId !== ref.fileId || revision.revisionId !== ref.revisionId) {
      throw new DomainError('FILE_REFERENCE_METADATA_INVALID', 'Reference metadata did not match the requested pin.', 500)
    }
    if (context.runId) {
      const pin = (await this.dependencies.reads.pinned(context.runId, [ref.fileId])).get(ref.fileId)
      if (pin && pin !== ref.revisionId) return pinConflict()
    }
    if (file.state === 'pending' || file.state === 'removed') return unavailable(file.state)
    if (file.state !== 'ready') return unavailable('not_found')
    if (input.offset > revision.byteSize) {
      throw new DomainError('FILE_RANGE_INVALID', 'The offset is outside this immutable revision.', 416)
    }
    let stream: Readable
    try { stream = await this.dependencies.bytes.download(stored.storageKey, revision, input) }
    catch (error) {
      if (error instanceof DomainError && error.code === 'FILE_BYTES_UNAVAILABLE') return unavailable('not_found')
      throw error
    }
    const content = await readReferenceRange(stream, 0, input.length, revision.byteSize - input.offset)
    const readAt = this.now()
    if (Date.parse(readAt) < Date.parse(revision.createdAt)) throw new Error('Read time predates the immutable revision.')
    // Only successful bounded reads reach this transaction. The file-row lock serializes removal;
    // Run-wide pins and execution facts commit together, before any bytes are returned to the caller.
    const state = await this.dependencies.reads.complete(context, ref, readAt,
      (query) => this.reauthorize(principal, subject, context, query))
    if (state !== 'ready') return unavailable(state)
    return { status: 'ready', file, revision, readAt, offset: input.offset,
      byteLength: content.length, contentBase64: content.toString('base64'), eof: input.offset + content.length === revision.byteSize }
  }
}
