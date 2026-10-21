import { createAdmittedNativeManager } from '../admittedManager.js'
import type { ClaudeNativeAllocationResult } from './composition.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'
import { DomainError } from '../../errors.js'

/** Claude adds its actual first-input and owned-control capability to the shared
 * admitted lifetime; it never advertises a pre-input native session ID. */
export function createAdmittedClaudeManager(initialize: (signal: AbortSignal) => Promise<ClaudeNativeAllocationResult>) {
  const admitted = createAdmittedNativeManager('claude', initialize)
  const manager: ClaudeNativeSessionManager = {
    ...admitted.manager,
    hasResidentSession: session => admitted.peek()?.hasResidentSession(session) ?? false,
    retireTurn: async (session, correlationId) => admitted.peek()?.retireTurn?.(session, correlationId),
    prepareInspection: async (start, signal) => (await admitted.actual(signal)).prepareInspection(start, signal),
    refreshInspectionCredentials: async (start, servers, signal) => (await admitted.actual(signal)).refreshInspectionCredentials(start, servers, signal),
    refreshSessionCredentials: async (session, start, servers, signal) =>
      (await admitted.actual(signal)).refreshSessionCredentials(session, start, servers, signal),
    rebindApplicationAccess: async (session, start, signal) => {
      const current = await admitted.actual(signal)
      if (!current.rebindApplicationAccess) throw new DomainError('NATIVE_CREDENTIAL_REBIND_UNAVAILABLE',
        'The admitted Claude driver cannot change its application subject.', 409)
      await current.rebindApplicationAccess(session, start, signal)
    },
    async *startInitialTurn(start, input, signal) { yield* (await admitted.actual(signal)).startInitialTurn(start, input, signal) },
    nativeCallbackContext: (sessionId, toolUseId) => {
      // Synchronous callbacks can run only after initialization. Keep the exact
      // provider's process-local map rather than recreating callback identities.
      return current?.nativeCallbackContext(sessionId, toolUseId)
    },
    callbackAuthority: context => current?.callbackAuthority(context),
    observeSubagentHook: (sessionId, agentId, agentType, status) => current?.observeSubagentHook?.(sessionId, agentId, agentType, status),
    notifyPendingChanged: notification => current?.notifyPendingChanged(notification),
    waitNativeCallbackContext: async (toolUseId, signal, sessionId) => (await admitted.actual(signal)).waitNativeCallbackContext(toolUseId, signal, sessionId),
  }
  let current: ClaudeNativeSessionManager | undefined
  const capture = admitted.actual
  admitted.actual = async signal => { current = await capture(signal); return current }
  return { harness: 'claude' as const, manager, inspector: admitted.inspector }
}
