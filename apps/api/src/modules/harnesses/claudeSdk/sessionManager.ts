import { runtimeFor, createClaudeManagerContext } from './sessionState.js'
import * as callbacks from './sessionCallbacks.js'
import * as inspection from './sessionInspection.js'
import * as opening from './sessionOpening.js'
import * as settings from './sessionSettings.js'
import * as turns from './sessionTurns.js'
import type { ClaudeNativeSessionManager, ClaudeNativeSessionManagerOptions } from './sessionTypes.js'

export { claudePromptUuid } from './sessionTypes.js'
export type { ClaudeMessageSubmission, ClaudeMessageTurnInput, ClaudeSessionQualification, ClaudeInitialTurnInput,
  ClaudeNativeSessionManager, ClaudeNativeSessionManagerOptions } from './sessionTypes.js'

/**
 * Composes one Claude SDK session manager. Its shared state lives in an explicit ClaudeManagerContext; each
 * responsibility is a module of functions over that context: callbacks, inspection, opening (lifecycle),
 * settings (preferences and compaction), turns, plus the output pump and credential delivery they use.
 */
export function createClaudeNativeSessionManager(options: ClaudeNativeSessionManagerOptions): ClaudeNativeSessionManager {
  const ctx = createClaudeManagerContext(options)
  const manager: ClaudeNativeSessionManager = {
    harness: ctx.harness,
    hasResidentSession(session) {
      const runtime = ctx.resident.get(session.nativeSessionId)
      return !ctx.disposed && runtime !== undefined && !runtime.closed && !runtime.failure
        && session.harness === ctx.harness && session.providerVersion === runtime.session?.providerVersion
    },
    requiresRuntimeClosure: () => ctx.options.runner.requiresRuntimeClosure?.() ?? ctx.all.size > 0,
    callbackAuthority(context) { return callbacks.callbackAuthority(ctx, context) },
    observeSubagentHook(sessionId, agentId, agentType, status) { callbacks.observeSubagentHook(ctx, sessionId, agentId, agentType, status) },
    notifyPendingChanged(notification) { callbacks.notifyPendingChanged(ctx, notification) },
    nativeCallbackContext(nativeSessionId, toolUseId) { return callbacks.findCallbackContext(ctx, toolUseId, nativeSessionId) },
    waitNativeCallbackContext(toolUseId, signal, nativeSessionId) {
      return callbacks.waitNativeCallbackContext(ctx, toolUseId, signal, nativeSessionId)
    },
    inspectResponseAvailability(session, query, signal) { return callbacks.inspectResponseAvailability(ctx, session, query, signal) },
    capabilities() { return inspection.capabilities(ctx) },
    refreshInspectionCredentials(start, servers, signal) { return inspection.refreshInspectionCredentials(ctx, start, servers, signal) },
    refreshSessionCredentials(session, start, servers, signal) {
      return inspection.refreshSessionCredentials(ctx, session, start, servers, signal)
    },
    prepareInspection(start, signal) { return inspection.prepareInspection(ctx, start, signal) },
    inspectMcp(signal) { return inspection.inspectMcp(ctx, signal) },
    createSession(start, signal) { return opening.createSession(manager, start, signal) },
    startInitialTurn(start, input, signal) { return opening.startInitialTurn(ctx, start, input, signal) },
    attachSession(session, start, signal) { return opening.attachSession(ctx, manager, session, start, signal) },
    configureSessionPreferences(preferences) { return settings.configureSessionPreferences(ctx, preferences) },
    applySessionPreferences(session, preferences, signal) { return settings.applySessionPreferences(ctx, session, preferences, signal) },
    sessionControlCapabilities(session) { return settings.sessionControlCapabilities(ctx, session) },
    appliedSessionPreferences(session) { return runtimeFor(ctx, session).appliedPreferences ?? null },
    contextSnapshot(session) { return runtimeFor(ctx, session).context ?? null },
    compactSession(session, input, signal) { return settings.compactSession(ctx, session, input, signal) },
    reconcileCompaction(session, state, signal) { return settings.reconcileCompaction(ctx, session, state, signal) },
    startTurn(session, rawInput, signal) { return turns.startTurn(ctx, session, rawInput, signal) },
    forkSession(source, start, signal) { return opening.forkSession(ctx, source, start, signal) },
    pending(session, signal) { return turns.pending(ctx, session, signal) },
    respond(session, requestId, option, signal) { return turns.respond(ctx, session, requestId, option, signal) },
    stopAutomaticResponses(session) { ctx.options.interactionPort?.stopAutomaticResponses?.(session); ctx.options.cancelPendingRequests?.() },
    cancel(session, signal, nativeMessageId) { return turns.cancel(ctx, session, signal, nativeMessageId) },
    subagentHistory(session, cursor, signal) { return turns.subagentHistory(ctx, session, cursor, signal) },
    history(session) { return turns.history(ctx, session) },
    retireTurn(session, correlationId) { return turns.retireTurn(ctx, session, correlationId) },
    reconcile(session, correlationId, signal) { return turns.reconcile(ctx, session, correlationId, signal) },
    async reconcileResponse(session, response, signal) { return ctx.options.interactionPort?.reconcileResponse?.(session, response, signal) ?? manager.history(session) },
    close(session) { return opening.close(ctx, session) },
    async closeForRestart(session) { return runtimeFor(ctx, session).sdk.closeForRestart() },
    dispose() { return opening.dispose(ctx) },
  }
  return manager
}
