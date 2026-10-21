import type { FastifyInstance } from 'fastify'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { productionFileTools } from '../../files/tools/production.js'
import { prepareCodexFileTurn, type PrepareCodexFileTurnDependencies } from './index.js'
import type { AcceptedCodexFileTurn, CodexFileServices } from './port.js'
import type { CodexChatFiles } from './runtime.js'

export interface CodexChatFileAdmission {
  /** Exact persisted native correlation; admissionId remains the send receipt ID. */
  clientCorrelationId: string
  accepted: AcceptedCodexFileTurn & { messageId: string }
  dependencies: Omit<PrepareCodexFileTurnDependencies, 'files'>
  /** Must atomically union exact pins into THIS persisted message, idempotently.
   * Re-check native session/turn + message identity, not the current active chat.
   * Adoption repairs a ready publication; it never authorizes a new file write.
   * An empty refs array reconciles all finalized publications for this turn. */
  adoptPublished(nativeTurnId: string, refs: readonly MessageAttachmentRef[]): Promise<void>
}

/** FIL-10 supplies authenticated admissions; the execution-host lane supplies the
 * source/lease. No permission, owner, run, or host is inferred in this adapter. */
export interface ProductionCodexChatFiles {
  resolve(input: {
    conversationId: string
    session: NativeSessionReference
    clientCorrelationId: string
    signal: AbortSignal
  }): Promise<CodexChatFileAdmission | undefined>
}

/** Uses the existing production FIL-05 service; no MCP credential exchange,
 * second transport, Operator credential, or worker credential is introduced. */
export function productionCodexChatFiles(app: () => FastifyInstance, conversationId: string,
  admissions: ProductionCodexChatFiles): CodexChatFiles {
  return {
    async prepare(input) {
      const admission = await admissions.resolve({ ...input, conversationId })
      if (!admission) return undefined
      const { accepted } = admission
      if (accepted.scope.chat.conversationId !== conversationId
        || accepted.nativeSessionId !== input.session.nativeSessionId
        || admission.clientCorrelationId !== input.clientCorrelationId || !accepted.messageId) {
        await admission.dependencies.host.close()
        throw new Error('CODEX_FILE_ADMISSION_MISMATCH')
      }
      let service: ReturnType<typeof productionFileTools>
      try {
        input.signal.throwIfAborted()
        service = productionFileTools(app())
      } catch (error) {
        await admission.dependencies.host.close()
        throw error
      }
      let nativeTurnId: string | undefined
      // Intercept only trusted service results, before returning them to Codex.
      // Adoption still runs if cancel arrives immediately after durable publish;
      // it neither needs a replacement token nor reads a mutable host path.
      const files: CodexFileServices = {
        sessions: {
          issueForAcceptedSession: async (context, expiresAt) => {
            const token = await service.sessions.issueForAcceptedSession(context, expiresAt)
            nativeTurnId = context.turnId
            return token
          },
          authenticate: (...args) => service.sessions.authenticate(...args),
          revoke: (...args) => service.sessions.revoke(...args),
          renew: (...args) => service.sessions.renew(...args),
        },
        artifacts: service.artifacts,
        list: (...args) => service.list(...args),
        read: (...args) => service.read(...args),
        createWorkingCopy: (...args) => service.createWorkingCopy(...args),
        writeWorkingCopy: (...args) => service.writeWorkingCopy(...args),
        applyFormatEdit: (...args) => service.applyFormatEdit(...args),
        publishedForTurn: (...args) => service.publishedForTurn(...args),
        publish: async (...args) => {
          const result = await service.publish(...args)
          if (!nativeTurnId) throw new Error('CODEX_FILE_TURN_NOT_ACCEPTED')
          await admission.adoptPublished(nativeTurnId, [{
            fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId,
          }])
          return result
        },
      }
      const host = admission.dependencies.host
      return prepareCodexFileTurn(accepted, { ...admission.dependencies, editsOnly: true, files,
        host: {
          executionHostId: host.executionHostId, pathStyle: host.pathStyle,
          materialize: (value) => host.materialize(value),
          sealCompleted: (id) => host.sealCompleted(id),
          close: async () => {
            // CodexFileTurn revokes and drains every call before closing its lease.
            // Reconcile the ledger even when publish committed but never returned.
            // A failed adoption leaves close retryable and the next turn fenced.
            if (nativeTurnId) await admission.adoptPublished(nativeTurnId, [])
            await host.close()
          },
        },
      }, input.signal)
    },
  }
}
