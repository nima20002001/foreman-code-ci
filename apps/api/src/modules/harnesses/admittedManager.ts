import type { AgentHarness } from '@foreman-code/contracts'
import { unavailableSessionControls } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { NativeMcpInspector } from './mcpDetection.js'
import type { NativeHarnessSessionManager } from './port.js'
import { unavailableNativeResponse } from './responseAvailability.js'
import { NativeDeliveryError } from './errors.js'

/** One async domain admission behind the existing synchronous role factory.
 * The returned lifetime owns initialization and its actual adapter cleanup. */
export function createAdmittedNativeManager<T extends NativeHarnessSessionManager>(harness: AgentHarness,
  initialize: (signal: AbortSignal) => Promise<{
    manager: T; inspector?: NativeMcpInspector
  }>) {
  const lifetime = new AbortController()
  let allocation: { manager: T; inspector?: NativeMcpInspector } | undefined
  let opening: Promise<{ manager: T; inspector?: NativeMcpInspector }> | undefined
  let disposal: Promise<void> | undefined
  const stopped = new Map<string, Parameters<NonNullable<NativeHarnessSessionManager['stopAutomaticResponses']>>[0]>()
  const actual = async (signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
    opening ??= Promise.resolve().then(() => initialize(lifetime.signal)).then(async result => {
      allocation = result
      if (lifetime.signal.aborted || result.manager.harness !== harness) {
        await result.manager.dispose?.()
        if (lifetime.signal.aborted) throw lifetime.signal.reason
        throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The admitted native adapter differs from its role configuration.', 409)
      }
      for (const session of stopped.values()) result.manager.stopAutomaticResponses?.(session)
      if (result.manager.retireTurn) {
        const retireTurn = result.manager.retireTurn.bind(result.manager)
        manager.retireTurn = async (session, correlationId) => {
          lifetime.signal.throwIfAborted()
          return retireTurn(session, correlationId)
        }
      }
      if (result.manager.rebindApplicationAccess) {
        const rebind = result.manager.rebindApplicationAccess.bind(result.manager)
        manager.rebindApplicationAccess = async (session, start, signal) => {
          signal?.throwIfAborted()
          lifetime.signal.throwIfAborted()
          await rebind(session, start, signal)
        }
      }
      return result
    })
    const result = await opening
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
    return result.manager
  }
  const manager: NativeHarnessSessionManager = {
    harness,
    requiresRuntimeClosure: () => allocation?.manager.requiresRuntimeClosure?.() ?? Boolean(allocation),
    requiresSettledDisposal: () => allocation?.manager.requiresSettledDisposal?.() ?? false,
    canDetachForRestart: session => allocation?.manager.canDetachForRestart?.(session) ?? false,
    originalEnvironment: async (session, signal) => (await actual(signal)).originalEnvironment?.(session, signal),
    capabilities: async signal => (await actual(signal)).capabilities(signal),
    applySessionPreferences: async (session, preferences, signal) => {
      const current = await actual(signal)
      if (!current.applySessionPreferences) throw new DomainError('SESSION_PREFERENCES_RESUME_REQUIRED', 'These settings need an owned startup or safe resume.', 409)
      await current.applySessionPreferences(session, preferences, signal)
    },
    configureSessionPreferences: async preferences => {
      const current = await actual()
      if (current.configureSessionPreferences) await current.configureSessionPreferences(preferences)
    },
    sessionControlCapabilities: async session => {
      const current = await actual()
      return current.sessionControlCapabilities ? current.sessionControlCapabilities(session)
        : unavailableSessionControls(`${harness}:${session.providerVersion}`, 'This admitted driver does not expose native session controls.')
    },
    compactSession: async (session, input, signal) => {
      const current = await actual(signal)
      if (!current.compactSession) throw new DomainError('SESSION_COMPACT_UNSUPPORTED', 'This harness cannot compact this session.', 409)
      return current.compactSession(session, input, signal)
    },
    readCompaction: async (session, start, state, signal) => {
      const current = await actual(signal)
      return current.readCompaction ? current.readCompaction(session, start, state, signal) : state
    },
    reconcileCompaction: async (session, state, signal) => {
      const current = await actual(signal)
      return current.reconcileCompaction ? current.reconcileCompaction(session, state, signal) : state
    },
    appliedSessionPreferences: session => allocation?.manager.appliedSessionPreferences?.(session) ?? null,
    contextSnapshot: session => allocation?.manager.contextSnapshot?.(session) ?? null,
    inspectMcp: async signal => (await actual(signal)).inspectMcp(signal),
    createSession: async (start, signal) => {
      let current: T
      try { current = await actual(signal) } catch (error) {
        throw new NativeDeliveryError('session_creation', 'not_sent', error)
      }
      return current.createSession(start, signal)
    },
    attachSession: async (session, start, signal) => (await actual(signal)).attachSession(session, start, signal),
    async *startTurn(session, input, signal) {
      let current: T
      try { current = await actual(signal) } catch (error) {
        throw new NativeDeliveryError('turn_submission', 'not_sent', error)
      }
      yield* current.startTurn(session, input, signal)
    },
    forkSession: async (source, start, signal) => {
      let current: T
      try { current = await actual(signal) } catch (error) {
        throw new NativeDeliveryError('session_creation', 'not_sent', error)
      }
      if (!current.forkSession) throw new DomainError('HARNESS_FORK_UNAVAILABLE', 'The admitted driver has no fork capability.', 409)
      return current.forkSession(source, start, signal)
    },
    pending: async (session, signal) => (await actual(signal)).pending(session, signal),
    respond: async (session, requestId, option, signal) => (await actual(signal)).respond(session, requestId, option, signal),
    stopAutomaticResponses(session) { stopped.set(session.nativeSessionId, session); allocation?.manager.stopAutomaticResponses?.(session) },
    cancel: async (session, signal, turnId) => (await actual(signal)).cancel(session, signal, turnId),
    subagentHistory: async (session, cursor, signal) => {
      const current = await actual(signal)
      if (!current.subagentHistory) throw new DomainError('SUBAGENT_HISTORY_UNAVAILABLE', 'The admitted driver has no child history reader.', 409)
      return current.subagentHistory(session, cursor, signal)
    },
    subagentControl: (child, assertOwner) => lifetime.signal.aborted ? undefined
      : allocation?.manager.subagentControl?.(child, () => { lifetime.signal.throwIfAborted(); assertOwner() }),
    history: async (session, signal) => (await actual(signal)).history(session, signal),
    reconcile: async (session, correlationId, signal) => (await actual(signal)).reconcile(session, correlationId, signal),
    reconcileResponse: async (session, response, signal) => {
      const current = await actual(signal)
      return current.reconcileResponse ? current.reconcileResponse(session, response, signal) : current.history(session, signal)
    },
    inspectResponseAvailability: async (session, query, signal) => {
      const current = await actual(signal)
      return current.inspectResponseAvailability ? current.inspectResponseAvailability(session, query, signal) : unavailableNativeResponse(session, query, 'unsupported')
    },
    close: async session => (await actual()).close(session),
    closeForResume: async session => {
      const current = await actual()
      if (!current.closeForResume) throw new DomainError('NATIVE_RUNTIME_RELEASE_UNAVAILABLE',
        'The admitted driver cannot release its process while retaining the conversation.', 409)
      await current.closeForResume(session)
    },
    closeForRestart: async session => {
      const current = await actual()
      if (!current.closeForRestart) throw new DomainError('HARNESS_RESTART_UNAVAILABLE', 'The admitted driver has no restart capability.', 409)
      return current.closeForRestart(session)
    },
    dispose() {
      const disposed = new DomainError('NATIVE_MANAGER_DISPOSED', 'The admitted native allocation is disposed.', 409)
      if (!allocation) lifetime.abort(disposed)
      disposal ??= Promise.resolve().then(async () => {
        if (opening) await opening.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
        await allocation?.manager.dispose?.()
        lifetime.abort(disposed)
        stopped.clear()
      })
      const attempt = disposal
      void attempt.catch(() => { if (disposal === attempt) disposal = undefined })
      return attempt
    },
  }
  if (harness === 'codex') {
    manager.reconcileSessionCreation = async (start, signal, forkSource) => {
      signal?.throwIfAborted()
      lifetime.signal.throwIfAborted()
      const current = allocation?.manager ?? (opening ? (await opening).manager : undefined)
      if (!current) {
        throw new DomainError('NATIVE_SESSION_CREATION_STATE_LOST', 'The original native creation state is no longer available.', 409)
      }
      if (!current.reconcileSessionCreation) {
        throw new DomainError('HARNESS_CREATION_UNCONFIRMED', 'The original native creation is not available.', 409)
      }
      const session = await current.reconcileSessionCreation(start, signal, forkSource)
      signal?.throwIfAborted()
      lifetime.signal.throwIfAborted()
      return session
    }
    manager.steerTurn = async (session, input, signal) => {
      const current = await actual(signal)
      if (!current.steerTurn) throw new DomainError('HARNESS_STEER_UNAVAILABLE', 'The admitted driver cannot steer this turn.', 409)
      return current.steerTurn(session, input, signal)
    }
    manager.reconcileSteers = async (session, inputs, signal) => (await actual(signal)).reconcileSteers?.(session, inputs, signal) ?? []
  }
  const inspector: NativeMcpInspector = { async inspect(request) {
    await actual(request.signal)
    if (!allocation?.inspector) throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The admitted driver has no MCP inspector.', 503)
    return allocation.inspector.inspect(request)
  } }
  return { manager, inspector, actual, peek: () => lifetime.signal.aborted ? undefined : allocation?.manager }
}
