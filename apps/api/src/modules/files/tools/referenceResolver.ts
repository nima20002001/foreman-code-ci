import { FileRowSchema } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import type { FileRepository } from '../repository.js'
import type { FileByteStorage } from '../storage.js'
import type { AgentReferenceService } from '../references/agentService.js'
import type { FileReferenceResolver } from './types.js'

/** The file session selects a persisted conversation; tool arguments only assert the desired scope. */
export function agentFileReferenceResolver(references: AgentReferenceService,
  files: Pick<FileRepository, 'read'>, bytes?: Pick<FileByteStorage, 'download'>): FileReferenceResolver {
  return {
    async list(caller, scope, page) {
      const manifest = await references.forConversation(caller.principal, caller.context.scope.chat.conversationId).list(page)
      const items = await Promise.all(manifest.items.filter((entry) => entry.scope.kind === scope.kind
        && entry.scope.workspaceId === scope.workspaceId
        && (scope.kind !== 'workflow_reference' || entry.scope.kind === 'workflow_reference'
          && entry.scope.workflowId === scope.workflowId)).map(async (entry) => {
        const stored = await files.read(entry.fileId, entry.revisionId)
        if (!stored || stored.value.file.currentRevisionId !== entry.revisionId) {
          throw new DomainError('FILE_REFERENCE_METADATA_UNAVAILABLE', 'Reference list metadata is unavailable.', 503)
        }
        return FileRowSchema.parse(stored.value)
      }))
      return { items, pageInfo: manifest.pageInfo }
    },
    async open(caller, ref) {
      // Keep list/read-only compositions source-compatible; production supplies the byte store.
      if (!bytes) throw new DomainError('FILE_REFERENCE_RESOLVER_REQUIRED', 'Reference copies require a byte reader.', 409)
      // Reuse FIL-37's inheritance authorization, Run pin and completed-read provenance.
      // One bounded read authorizes the exact revision; the copy then streams its verified
      // object once, rather than rehashing the whole file for every 64-KiB range.
      const authorized = await references.forConversation(caller.principal,
        caller.context.scope.chat.conversationId).read({ ...ref, offset: 0, length: 1 })
      if (authorized.status !== 'ready' || authorized.file.scope.kind === 'temporary') {
        throw new DomainError('FILE_UNAVAILABLE', 'The pinned reference is unavailable.', 410)
      }
      const stored = await files.read(ref.fileId, ref.revisionId)
      if (!stored || stored.value.file.state !== 'ready' || stored.value.file.scope.kind === 'temporary'
        || stored.value.file.currentRevisionId !== ref.revisionId) {
        throw new DomainError('FILE_UNAVAILABLE', 'The pinned reference is unavailable.', 410)
      }
      return { value: { file: authorized.file, revision: authorized.revision },
        stream: await bytes.download(stored.storageKey, authorized.revision) }
    },
    read(caller, input) {
      return references.forConversation(caller.principal, caller.context.scope.chat.conversationId).read(input)
    },
  }
}
