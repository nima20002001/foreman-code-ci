import { ArtifactAttemptSchema, type ArtifactAttempt } from '@foreman-code/contracts/artifact-edges'
import { VerifiedTransferReceiptSchema, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, fileStateAt, type AgentFilePublishResult,
  type MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { FileToolContext } from '../tools/types.js'
import type { TemporaryFileService } from '../service.js'
import { digest, targetOf } from '../tools/context.js'
import { fileScopeIdentity } from '../requests.js'
import { DomainError } from '../../errors.js'
import type { AcceptedArtifactPublication, ArtifactPublicationAuthority } from './publication.js'
import type { DistributedPublicationLedger } from './publicationLedger.js'

export interface CanonicalNativeArtifactResult {
  attempt: ArtifactAttempt
  nativeIdentity: Pick<FileToolContext, 'nativeSessionId' | 'turnId' | 'nativeMessageId' | 'messageId'>
  publication: { ownerPrincipalId: string; requestId: string; binding: string }
  pins: MessageAttachmentRef & { sha256: string; byteSize: number }
  value: AgentFilePublishResult['value']
  transferReceipt: VerifiedTransferReceipt
}

/** Main-only result/adoption port. HRT supplies the original accepted native identity and
 * persisted command; worker paths, text output and transfer completion are not results. */
export class CanonicalNativeArtifactResults {
  constructor(private readonly files: TemporaryFileService, private readonly ledger: DistributedPublicationLedger,
    private readonly authority: Pick<ArtifactPublicationAuthority, 'authorize'>, private readonly clock: () => Date = () => new Date()) {}

  async readAccepted(accepted: AcceptedArtifactPublication, commandId: string): Promise<CanonicalNativeArtifactResult> {
    const attempt = ArtifactAttemptSchema.parse(accepted.attempt)
    accepted = { ...accepted, attempt }
    commandId = AgentFilePublishInputSchema.shape.commandId.parse(commandId)
    const caller = await this.authority.authorize(accepted)
    if (!caller.context.allowedTools.includes('files.list')) {
      throw new DomainError('FILE_TOOL_DENIED', 'The accepted sender cannot read publication results.', 403)
    }
    const requestId = `fil05:remote:${digest(commandId)}`
    const link = await this.ledger.read(caller.principal.id, requestId)
    if (!link) throw new DomainError('FILE_PUBLICATION_PENDING', 'The original publication has not been recorded.', 409)
    const receipt = VerifiedTransferReceiptSchema.parse(link.transferReceipt), intent = receipt.intent
    const chat = caller.context.scope.chat, context = accepted.transferContext
    if (link.ownerPrincipalId !== caller.principal.id || link.binding !== caller.binding
      || link.context.nativeSessionId !== caller.context.nativeSessionId || link.context.turnId !== caller.context.turnId
      || link.context.nativeMessageId !== caller.context.nativeMessageId || link.context.messageId !== caller.context.messageId
      || fileScopeIdentity(link.context.scope) !== fileScopeIdentity(caller.context.scope)
      || chat.kind !== 'agent' || chat.workspaceId !== attempt.workspaceId || chat.workflowId !== attempt.workflowId
      || chat.runId !== attempt.runId || chat.executionId !== attempt.executionId
      || intent.executionId !== attempt.executionId || intent.attemptId !== attempt.attemptId
      || intent.placementHash !== attempt.placementHash || intent.mainId !== context.mainId
      || intent.deviceId !== context.deviceId || intent.workerInstallationId !== context.workerInstallationId
      || intent.keyRevision !== context.keyRevision || intent.authorizationRevision !== context.authorizationRevision
      || intent.direction !== 'to-main' || intent.byteClass !== 'artifact' || intent.transferId !== receipt.transferId
      || intent.sha256 !== receipt.sha256 || intent.byteSize !== receipt.byteSize) {
      throw new DomainError('FILE_PUBLICATION_CONFLICT', 'The original publication does not belong to this accepted native attempt.', 409)
    }
    // The common download path verifies canonical bytes and current retention. This does
    // not require transfer staging to survive, and never extends either expiry deadline.
    const opened = await this.files.download(caller.principal, targetOf(caller.context), link.ref)
    try {
      if (opened.revision.sha256 !== receipt.sha256 || opened.revision.byteSize !== receipt.byteSize) {
        throw new DomainError('FILE_PUBLICATION_CONFLICT', 'Canonical bytes differ from the original verified receipt.', 409)
      }
    } finally { opened.stream.destroy() }
    const current = await this.authority.authorize(accepted)
    if (current.principal.id !== caller.principal.id || current.binding !== caller.binding
      || !current.context.allowedTools.includes('files.list')) {
      throw new DomainError('FILE_TOOL_DENIED', 'Publication result authority changed during verification.', 403)
    }
    const stored = await this.files.repository.read(link.ref.fileId, link.ref.revisionId)
    if (!stored) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'Canonical publication metadata is unavailable.', 410)
    // download already checked lifecycle after I/O; recheck after the final authority wait.
    if (fileStateAt(stored.value.file, this.clock().toISOString()) !== 'ready') {
      throw new DomainError('FILE_BYTES_UNAVAILABLE', 'Canonical publication bytes expired during verification.', 410)
    }
    if (stored.value.revision.sha256 !== receipt.sha256 || stored.value.revision.byteSize !== receipt.byteSize
      || fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(caller.context.scope)) {
      throw new DomainError('FILE_PUBLICATION_CONFLICT', 'Canonical publication identity changed during verification.', 409)
    }
    const value = AgentFilePublishResultSchema.parse({ value: stored.value, replayed: true }).value
    return { attempt, nativeIdentity: { nativeSessionId: link.context.nativeSessionId,
      ...(link.context.turnId ? { turnId: link.context.turnId } : {}),
      ...(link.context.nativeMessageId ? { nativeMessageId: link.context.nativeMessageId } : {}),
      ...(link.context.messageId ? { messageId: link.context.messageId } : {}) },
      publication: { ownerPrincipalId: link.ownerPrincipalId, requestId, binding: link.binding },
      pins: { ...link.ref, sha256: receipt.sha256, byteSize: receipt.byteSize }, value, transferReceipt: receipt }
  }
}
