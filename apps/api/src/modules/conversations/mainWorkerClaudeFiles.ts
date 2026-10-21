import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { WorkerClaudeAuthorityRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { AgentFileToolService } from '../files/tools/service.js'
import { ClaudeFileBridge } from '../harnesses/claudeSdk/files.js'
import { productionClaudeFileAdmission } from '../harnesses/claudeSdk/fileProduction.js'
import type { ClaudeCallbackIdentity } from '../harnesses/claudeSdk/interactions.js'
import type { ClaudeDomainBinding } from '../harnesses/claudeSdk/domainAuthority.js'
import type { ClaudeNativeCallbackContext } from '../harnesses/claudeSdk/callbackAvailability.js'
import { DomainError } from '../errors.js'

/** Main retains file credentials; the paired SDK owner supplies only an acknowledged root callback. */
export function createMainWorkerClaudeFiles(input: {
  pool: pg.Pool
  binding: Exclude<ClaudeDomainBinding, { kind: 'workflow' }>
  service(): AgentFileToolService
  allowMutation: boolean
}) {
  const current = new AsyncLocalStorage<ClaudeCallbackIdentity>()
  const bridges = new Set<ClaudeFileBridge>()
  let closed = false
  const manager = {
    nativeCallbackContext(sessionId: string, toolUseId: string): ClaudeNativeCallbackContext | undefined {
      const identity = current.getStore()
      if (closed || !identity || identity.nativeSessionId !== sessionId || identity.toolUseId !== toolUseId
        || !identity.nativeMessageId || !identity.clientCorrelationId || !identity.generation) return undefined
      return { nativeSessionId: identity.nativeSessionId, nativeMessageId: identity.nativeMessageId,
        clientCorrelationId: identity.clientCorrelationId, generation: identity.generation }
    },
    callbackAuthority(context: ClaudeNativeCallbackContext) {
      const identity = current.getStore()
      if (!identity || !isDeepStrictEqual(manager.nativeCallbackContext(identity.nativeSessionId, identity.toolUseId), context)
        || !identity.ownerPrincipalId) return undefined
      return { ownerPrincipalId: identity.ownerPrincipalId, attemptId: identity.attemptId }
    },
  }
  const admission = productionClaudeFileAdmission({ ...input, manager: () => manager })
  return {
    async call(request: Extract<WorkerClaudeAuthorityRequest, { phase: 'file' }>, identity: ClaudeCallbackIdentity,
      signal: AbortSignal) {
      signal.throwIfAborted()
      if (closed) throw new DomainError('CLAUDE_FILE_CONTEXT_DENIED', 'The file observer is closed.', 403)
      return current.run(identity, async () => {
        const bridge = new ClaudeFileBridge(identity, admission, input.service())
        bridges.add(bridge)
        try {
          return await bridge.call(request.operation, request.args, signal)
        } finally {
          await bridge.close()
          bridges.delete(bridge)
        }
      })
    },
    async close() {
      closed = true
      await Promise.all([...bridges].map(bridge => bridge.close()))
      bridges.clear()
    },
  }
}
