import { childHistoryCursor, childHistoryEvent, encodeChildHistoryCursor } from '../subagents/nativeReadback.js'
import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { HarnessExecutionError } from './errors.js'
import type { NativeHarnessSessionManager } from './port.js'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { SubagentControlLease } from '../subagents/types.js'
import { isObject, object, text, type JsonObject } from './codexStdioTransport.js'
import { CodexManagerSessions } from './codexAppServer/sessions.js'
import { snapshot } from './codexAppServer/support.js'
import type { Runtime, StartingTurn } from './codexAppServer/types.js'

export { safeEnvironment } from './codexAppServer/support.js'
export type { CodexTransport, CodexDiagnosticPin, CodexDiagnosticOperations, CodexSessionDependencies, CodexInspectionOptions,
  CodexOriginalResidency, CodexOriginalSessionLifetime, CodexMcpConfigurationInspection,
  CodexQualificationEvidence } from './codexAppServer/types.js'

/**
 * Codex app-server native session manager. Responsibilities are layered in ./codexAppServer/:
 * base (state, guards, event log) -> preparation (qualification, inputs, MCP policy) -> events (native callbacks)
 * -> connection (transport, restart, turn admission) -> controls (idle-session controls) -> turns (turns and
 * responses) -> sessions (creation, attachment, closure). This class adds native subagent readback and control.
 */
export class CodexAppServerSessionManager extends CodexManagerSessions implements NativeHarnessSessionManager {
  async subagentHistory(session: NativeSessionReference, cursor?: string, signal?: AbortSignal) {
    return this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      const transport = runtime.transport, generation = runtime.generation
      const current = () => {
        signal?.throwIfAborted()
        if (runtime.closed || runtime.disposed || runtime.transport !== transport || runtime.generation !== generation || transport.isConnected?.() !== true) {
          throw new DomainError('SUBAGENT_HISTORY_OWNER_STALE', 'The exact parent history owner is not connected.', 409)
        }
      }
      current()
      const metadata = (value: unknown): JsonObject => isObject(value) ? value : {}
      const page = childHistoryCursor(session.nativeSessionId, cursor)
      if (page.target !== session.nativeSessionId) {
        let target = page.target
        const visited = new Set<string>()
        while (target !== session.nativeSessionId) {
          if (visited.has(target) || visited.size >= 32) throw new DomainError('SUBAGENT_ANCESTRY_INVALID', 'Native child ancestry does not reach the admitted parent.', 409)
          visited.add(target)
          const response = object(await transport.request('thread/read', { threadId: target, includeTurns: false }, signal))
          current()
          const thread = object(response.thread)
          const spawn = metadata(metadata(metadata(thread.source).subAgent).thread_spawn)
          if (thread.id !== target || !text(thread.parentThreadId) || spawn.parent_thread_id !== thread.parentThreadId || thread.ephemeral === true) {
            throw new DomainError('SUBAGENT_ANCESTRY_INVALID', 'Native history did not prove the exact durable child ancestry.', 409)
          }
          target = thread.parentThreadId as string
        }
      }
      const response = object(await transport.request('thread/items/list', { threadId: page.target, cursor: page.cursor, limit: 50, sortDirection: 'asc' }, signal))
      current()
      if (!Array.isArray(response.data) || response.data.length > 50) throw new DomainError('SUBAGENT_HISTORY_INVALID', 'Native child item page is not bounded.', 409)
      const events: NativeHarnessEvent[] = []
      for (const raw of response.data) {
        const entry = object(raw), item = object(entry.item)
        if (!text(item.id) || !text(entry.turnId)) continue
        const root = page.target === session.nativeSessionId
        if (root && !['subAgentActivity', 'collabAgentToolCall'].includes(String(item.type))) continue
        if (!root && !['subAgentActivity', 'collabAgentToolCall', 'agentMessage', 'userMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(String(item.type))) continue
        const params = { threadId: page.target, turnId: entry.turnId, item }
        events.push(childHistoryEvent(root ? 'item.completed' : 'native.unlinked_notification', root ? params : { threadId: page.target, method: 'item/completed', params }))
      }
      const rootHistory = await this.history(session)
      const childIds = [...new Set([...(page.children ?? []), ...[...rootHistory.events, ...events].flatMap(event => {
        const payload = event.type === 'native.unlinked_notification' ? metadata(event.payload.params) : event.payload
        const item = metadata(payload.item)
        return item.type === 'subAgentActivity' && text(item.agentThreadId) ? [item.agentThreadId as string]
          : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => Boolean(text(id))) : []
      })])].filter(id => id !== session.nativeSessionId).sort()
      if (response.nextCursor != null && !text(response.nextCursor)) throw new DomainError('SUBAGENT_HISTORY_INVALID', 'Native page cursor is invalid.', 409)
      const nextTarget = page.target === session.nativeSessionId ? childIds[0] : childIds.find(id => id > page.target)
      return { events, nextCursor: response.nextCursor ? encodeChildHistoryCursor({ ...page, children: childIds, cursor: response.nextCursor as string })
        : nextTarget ? encodeChildHistoryCursor({ root: page.root, target: nextTarget, children: childIds, cursor: null }) : null }
    })
  }

  subagentControl(child: RunSubagent, assertOwner: () => void): SubagentControlLease | undefined {
    const runtime = [...this.runtimes.values()].find((candidate) => {
      const input = candidate.input
      return input.kind !== 'operator' && input.kind !== 'agent-chat' && input.request.executionId === child.parentExecutionId
        && input.request.runId === child.runId && input.request.workspaceId === child.workspaceId
        && input.request.configuration.agentId === child.parentAgentId
    })
    if (!runtime || runtime.closed || runtime.disposed || runtime.transport.isConnected?.() !== true) return undefined
    const transport = runtime.transport
    const generation = runtime.generation
    const current = () => {
      assertOwner()
      this.shutdownController.signal.throwIfAborted()
      if (this.runtimes.get(runtime.session.nativeSessionId) !== runtime || runtime.closed || runtime.disposed
        || runtime.transport !== transport || runtime.generation !== generation || transport.isConnected?.() !== true) {
        throw new HarnessExecutionError('SUBAGENT_OWNER_STALE', 'The admitted child control owner changed.')
      }
    }
    const lease = this.childControls.lease(child, {
      rootThreadId: runtime.session.nativeSessionId,
      generation: `${runtime.connectionId}:${generation}`,
      qualified: runtime.qualified,
      transport,
      assertCurrent: current,
      exclusive: (work) => this.exclusive(runtime.session.nativeSessionId, work),
      observeThread: thread => this.observeChildThread(runtime, child, thread, current),
      beginTurn: correlationId => this.beginChildTurn(child, correlationId, current),
    }, assertOwner)
    if (!lease) return undefined
    return { ...lease,
      pendingInteraction: () => {
        current()
        const owned = this.childRuntimes.get(child.native.childSessionId!)
        if (!owned || owned.runtime.parent !== runtime) return undefined
        return structuredClone([...owned.runtime.interactions.values()].find(entry => entry.delivery === 'pending')?.pending)
      },
      respond: receipt => this.exclusive(runtime.session.nativeSessionId, async () => {
        current()
        const response = receipt.response
        const owned = this.childRuntimes.get(child.native.childSessionId!)
        const pending = owned && [...owned.runtime.interactions.values()]
          .find(entry => entry.pending.turn.nativeRequestId === response?.nativeRequestId)?.pending
        if (!response || !owned || owned.runtime.parent !== runtime
          || receipt.operation !== 'run_subagent_respond_v1' || receipt.subagentId !== child.id
          || receipt.runId !== child.runId || receipt.workspaceId !== child.workspaceId
          || !pending || pending.nativeRequestType !== response.nativeRequestType
          || (pending.turn.nativeTurnId ?? null) !== receipt.nativeTurnId) {
          throw new HarnessExecutionError('SUBAGENT_RESPONSE_STALE', 'The child request is no longer owned.')
        }
        await this.respond(owned.runtime.session, response.nativeRequestId, response.option)
        current()
      }),
      reconcile: async receipt => {
        if (!receipt.response) return lease.reconcile!(receipt)
        current()
        // Native ancestry readback requalifies the child even when only its response journal survives.
        await lease.reconcile!(receipt)
        const session = { ...runtime.session, nativeSessionId: child.native.childSessionId! }
        const history = await this.reconcileResponse(session, receipt.response)
        return history.responseDeliveries?.some(proof => proof.nativeRequestId === receipt.response!.nativeRequestId
          && proof.optionId === receipt.response!.option.optionId) ? 'acknowledged' : 'uncertain'
      },
    }
  }

  protected observeChildThread(parent: Runtime, child: RunSubagent, thread: import('./codexMethodTypes.js').Thread,
    assertCurrent: () => void): void {
    assertCurrent()
    const previous = this.childRuntimes.get(thread.id)
    if (previous && previous.runtime.parent === parent && previous.runtime.generation === parent.generation) {
      previous.assertCurrent = assertCurrent
      return
    }
    const runtime: Runtime = { ...parent, parent, session: { ...parent.session, nativeSessionId: thread.id },
      starting: undefined, streamActive: false, activeTurnId: thread.turns.at(-1)?.id ?? child.native.currentTurnId,
      activeCorrelationId: undefined, terminalResult: undefined, phase: thread.status.type === 'active' ? 'active' : 'idle',
      finalAnswer: undefined, finalAnswerId: undefined, lastAgentMessage: undefined, lastAgentMessageId: undefined,
      files: undefined, fileCleanup: undefined, nativeOutput: undefined, nativeOutputCleanup: undefined,
      fileRequests: new Map(), interactions: new Map(), resolvedRequests: new Map(), callbackOwners: parent.callbackOwners,
      responseDecisions: new Map(), responseDeliveries: new Map(), rejectedStarts: new Map(), seenNotifications: new Set(),
      events: [], eventSizes: [], eventBytes: 0, sequence: 0, wake: new Set(), cancellation: undefined }
    delete runtime.context
    delete runtime.compaction
    delete runtime.compactionPreviousTurns
    this.childRuntimes.set(thread.id, { runtime, child, assertCurrent })
  }

  protected beginChildTurn(child: RunSubagent, correlationId: string, assertCurrent: () => void) {
    assertCurrent()
    const runtime = this.childRuntimes.get(child.native.childSessionId!)!.runtime
    let resolveIdentity!: StartingTurn['resolveIdentity']
    const nativeIdentity = new Promise<string | undefined>(resolve => { resolveIdentity = resolve })
    const starting: StartingTurn = { correlationId, previous: snapshot(runtime), cancelRequested: false,
      preparationController: new AbortController(), nativeIdentity, resolveIdentity, staged: [], stagedBytes: 0 }
    runtime.starting = starting
    runtime.phase = 'starting'
    runtime.activeTurnId = undefined
    runtime.activeCorrelationId = correlationId
    runtime.terminalResult = undefined
    return { acknowledge: async (value: unknown) => {
      assertCurrent()
      await this.acceptStartedTurn(runtime, starting, value)
    }, reject: () => this.restoreRejectedStart(runtime, starting) }
  }
}
