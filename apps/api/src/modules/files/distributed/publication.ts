import type { Readable } from 'node:stream'
import { VerifiedTransferReceiptSchema, type TransferContext, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { ArtifactAttemptSchema, type ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import type { TemporaryFileService } from '../service.js'
import type { FileToolContext, AuthorizedFileCaller } from '../tools/types.js'
import { digest, targetOf } from '../tools/context.js'
import { fileScopeIdentity } from '../requests.js'
import type { FileQuery } from '../repository.js'
import type { DistributedPublicationLedger } from './publicationLedger.js'
import { DomainError } from '../../errors.js'

/** W07 authenticates the connection, W08 looks up accepted ownership; neither comes from tool arguments. */
export interface AcceptedArtifactPublication {
  context: FileToolContext
  attempt: ArtifactAttempt
  transferContext: TransferContext
}
export interface ArtifactPublicationAuthority {
  authorize(accepted: AcceptedArtifactPublication, query?: FileQuery): Promise<AuthorizedFileCaller>
  assertSourceLive(accepted: AcceptedArtifactPublication, receipt: VerifiedTransferReceipt, query: FileQuery): Promise<void>
}
export interface VerifiedArtifactReader {
  resolveVerifiedReceipt(id: string, context: TransferContext): Promise<VerifiedTransferReceipt>
  openVerified(receipt: VerifiedTransferReceipt, context: TransferContext): Promise<Readable>
}
export class DistributedArtifactPublicationService {
  constructor(private readonly files: TemporaryFileService, private readonly ledger: DistributedPublicationLedger,
    private readonly transfers: VerifiedArtifactReader, private readonly authority: ArtifactPublicationAuthority,
    private readonly clock: () => Date = () => new Date()) {}
  /** Main-only seam. Public HTTP/MCP adapters must derive accepted identity before calling. */
  async publishAccepted(accepted: AcceptedArtifactPublication, transferId: string, raw: unknown,
    source: 'http' | 'mcp' = 'http') {
    accepted = { ...accepted, attempt: ArtifactAttemptSchema.parse(accepted.attempt) }
    const input = AgentFilePublishInputSchema.parse(raw)
    const caller = await this.authority.authorize(accepted)
    if (!caller.context.allowMutation || !caller.context.allowedTools.includes('files.publish_result')
      || fileScopeIdentity(input.scope) !== fileScopeIdentity(caller.context.scope)) {
      throw new DomainError('FILE_TOOL_DENIED', 'The accepted sender cannot publish into this scope.', 403)
    }
    const requestId = `fil05:remote:${digest(input.commandId)}`
    const publicationInputHash = digest(JSON.stringify([input, caller.binding, accepted.attempt, transferId]))
    const original = await this.ledger.read(caller.principal.id, requestId)
    if (original && original.publicationInputHash !== publicationInputHash) {
      throw new DomainError('FILE_REQUEST_CONFLICT', 'The publication retry differs from its original input.', 409)
    }
    const chat = caller.context.scope.chat
    if (chat.kind !== 'agent' || chat.workspaceId !== accepted.attempt.workspaceId
      || chat.workflowId !== accepted.attempt.workflowId || chat.runId !== accepted.attempt.runId
      || chat.executionId !== accepted.attempt.executionId) {
      throw new DomainError('FILE_PUBLICATION_CONFLICT', 'The accepted attempt is outside the originating conversation.', 409)
    }
    const receipt = VerifiedTransferReceiptSchema.parse(original?.transferReceipt
      ?? await this.transfers.resolveVerifiedReceipt(transferId, accepted.transferContext))
    const committed = original && (await this.files.repository.read(original.ref.fileId, original.ref.revisionId))?.value.file.state === 'ready'
    const intent = receipt.intent
    if (intent.mainId !== accepted.transferContext.mainId || intent.deviceId !== accepted.transferContext.deviceId
      || intent.workerInstallationId !== accepted.transferContext.workerInstallationId
      || intent.keyRevision !== accepted.transferContext.keyRevision || intent.authorizationRevision !== accepted.transferContext.authorizationRevision
      || intent.direction !== 'to-main' || intent.byteClass !== 'artifact' || receipt.transferId !== transferId
      || intent.executionId !== accepted.attempt.executionId || intent.attemptId !== accepted.attempt.attemptId
      || intent.placementHash !== accepted.attempt.placementHash
      || receipt.sha256 !== intent.sha256 || receipt.byteSize !== intent.byteSize) {
      throw new DomainError('FILE_TRANSFER_BINDING_CONFLICT', 'Verified bytes do not belong to the accepted attempt.', 409)
    }
    const check = async (query?: FileQuery) => {
      const current = await this.authority.authorize(accepted, query)
      if (current.binding !== caller.binding || current.principal.id !== caller.principal.id) {
        throw new DomainError('FILE_PUBLICATION_CONFLICT', 'Publication sender authority changed.', 409)
      }
      if (query) await this.authority.assertSourceLive(accepted, receipt, query)
      if (!committed && Date.parse(intent.expiresAt) <= this.clock().getTime()) throw new DomainError('FILE_EXPIRED', 'The original transfer expired.', 410)
      return current
    }
    const guard = { source, authorize: async (query: FileQuery) => { await check(query) } }
    const identity = digest(JSON.stringify([caller.binding, accepted.attempt, receipt.transferId, receipt.receiptId,
      intent.rootId, intent.rootBindingRevision, receipt.sha256, receipt.byteSize, input.artifactId]))
    // Canonical allocation preserves identity on retries, and rejects changed bytes/metadata/scope.
    await check()
    const allocated = await this.files.allocateAgentResult(caller.principal, targetOf(caller.context), {
      requestId, filename: input.filename, mediaType: input.mediaType, sha256: receipt.sha256, byteSize: receipt.byteSize,
    }, 'agent_output', identity, guard)
    await check()
    await this.ledger.linkPublication({ ownerPrincipalId: caller.principal.id, requestId,
      binding: caller.binding, context: caller.context,
      ref: { fileId: allocated.value.file.fileId, revisionId: allocated.value.revision.revisionId }, createdAt: original?.createdAt ?? this.clock().toISOString(), transferReceipt: receipt, publicationInputHash })
    if (allocated.value.file.state === 'ready') {
      const current = await check()
      const finalized = await this.files.finalize(current.principal, targetOf(current.context), requestId, source, guard)
      await check()
      return AgentFilePublishResultSchema.parse({ value: finalized.value, replayed: true })
    }
    const stream = await this.transfers.openVerified(receipt, accepted.transferContext)
    try {
      await this.files.upload(caller.principal, targetOf(caller.context), requestId, stream, {
        reauthorize: async () => (await check()).principal, commitAuthorization: guard,
        signal: AbortSignal.timeout(120_000), source,
      })
    } finally { stream.destroy() }
    const current = await check()
    const finalized = await this.files.finalize(current.principal, targetOf(current.context), requestId, source, guard)
    await check()
    return AgentFilePublishResultSchema.parse({ value: finalized.value, replayed: allocated.replayed })
  }
}
