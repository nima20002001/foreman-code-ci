import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { isDeepStrictEqual } from 'node:util'
import type { RunSubagent, RunSubagentCommandReceipt } from '@foreman-code/contracts/subagents'
import { SubagentDispatchRejectedError } from '../subagents/controlErrors.js'
import type { SubagentControlLease } from '../subagents/types.js'
import { codexRequest, type QualifiedCodex } from './codexProtocol.js'
import { CodexRpcError, isObject, type CodexStdioTransport, type JsonObject } from './codexStdioTransport.js'
import { HarnessExecutionError } from './errors.js'
import type { Thread, Turn, ThreadTurnsListResponse, ThreadItemsListResponse } from './codexMethodTypes.js'

export interface CodexChildControlHost {
  rootThreadId: string
  generation: string
  qualified: Pick<QualifiedCodex, 'protocol' | 'providerVersion' | 'schemaManifestSha256'>
  transport: Pick<CodexStdioTransport, 'request'>
  assertCurrent(): void
  exclusive<T>(work: () => Promise<T>): Promise<T>
  observeThread?(thread: Thread): void
  beginTurn?(correlationId: string): { acknowledge(value: unknown): Promise<void>; reject(): void }
}

type CommandOutcome = 'acknowledged' | 'rejected' | 'uncertain'

/** Child requests share the admitted parent's transport and preserve the child's native settings. */
export class CodexChildControls {
  private readonly attempts = new Map<string, CommandOutcome>()

  lease(child: RunSubagent, host: CodexChildControlHost, assertOwner: () => void): SubagentControlLease | undefined {
    const target = child.native.childSessionId
    if (child.provider !== 'codex' || !target || target === host.rootThreadId) return undefined
    const current = () => {
      assertOwner()
      host.assertCurrent()
    }
    const idle = ['waiting', 'completed'].includes(child.status)
    const turnId = idle ? null : child.native.currentTurnId ?? null
    const input = [{ type: 'text' as const, text: 'qualification', text_elements: [] }]
    const qualifies = (method: string, params: JsonObject) => {
      try {
        host.qualified.protocol.request({ id: 'child-control', method, params })
        return true
      } catch (error) {
        if (error instanceof HarnessExecutionError && ['CODEX_METHOD_UNQUALIFIED', 'CODEX_PROTOCOL_INVALID', 'CODEX_CONTRACT_UNSUPPORTED']
          .includes(error.result.error?.code ?? '')) return false
        throw error
      }
    }
    const readable = qualifies('thread/read', { threadId: target, includeTurns: false })
      && qualifies('thread/turns/list', { threadId: target, cursor: null, limit: 1, sortDirection: 'desc' })
    const resume = qualifies('thread/resume', { threadId: target, excludeTurns: true })
    const sendInput = readable && qualifies('thread/items/list', {
      threadId: target, cursor: null, limit: 50, sortDirection: 'asc',
    }) && (idle ? resume && qualifies('turn/start', { threadId: target, clientUserMessageId: 'correlation', input })
      : Boolean(turnId) && qualifies('turn/steer', {
        threadId: target, clientUserMessageId: 'correlation', input, expectedTurnId: turnId,
      }))
    const interrupt = readable && Boolean(turnId) && qualifies('turn/interrupt', { threadId: target, turnId })
    const capability = (supported: boolean) => supported
      ? { support: 'supported' as const, qualification: 'passed' as const }
      : { support: 'unverified' as const, qualification: 'unverified' as const }
    const read = async () => {
      current()
      const { thread } = await codexRequest(host.transport, 'thread/read', { threadId: target, includeTurns: false })
      current()
      await this.ancestry(child, thread, host, current)
      host.observeThread?.(thread)
      return thread
    }
    const checkReceipt = (receipt: RunSubagentCommandReceipt) => {
      current()
      if (receipt.subagentId !== child.id || receipt.workspaceId !== child.workspaceId || receipt.runId !== child.runId) {
        throw new SubagentDispatchRejectedError()
      }
    }
    const dispatch = (receipt: RunSubagentCommandReceipt, text?: string) => host.exclusive(async () => {
      let thread: Thread
      try {
        checkReceipt(receipt)
        const operation = text === undefined ? 'run_subagent_interrupt_v1' : 'run_subagent_input_v1'
        if (receipt.operation !== operation) throw new SubagentDispatchRejectedError()
        if (receipt.nativeTurnId !== turnId) throw new SubagentDispatchRejectedError()
        thread = await read()
        const latest = await this.latestTurn(target, host, current)
        if (idle ? latest?.status === 'inProgress' : latest?.id !== turnId || latest?.status !== 'inProgress') {
          throw new SubagentDispatchRejectedError()
        }
        if (text !== undefined && idle && thread.status.type === 'notLoaded') {
          const resumed = await codexRequest(host.transport, 'thread/resume', { threadId: target, excludeTurns: true })
          current()
          await this.ancestry(child, resumed.thread, host, current)
          const active = await this.latestTurn(target, host, current)
          if (active?.status === 'inProgress') throw new SubagentDispatchRejectedError()
        }
        current()
      } catch (error) {
        // Reads and resume cannot submit the child prompt or interrupt its turn.
        throw new SubagentDispatchRejectedError({ cause: error })
      }
      if (this.attempts.has(receipt.id)) throw new SubagentDispatchRejectedError()
      this.attempts.set(receipt.id, 'uncertain')
      const starting = text !== undefined && idle ? host.beginTurn?.(receipt.nativeCorrelationId) : undefined
      const late = (value: unknown, error?: Error) => {
        if (error) {
          if (error instanceof CodexRpcError && !error.uncertain) {
            starting?.reject()
            this.attempts.set(receipt.id, 'rejected')
          }
          return
        }
        if (starting) void starting.acknowledge(value).catch(error => {
          logIgnoredError('harness', 'acknowledge native child control', error)
          this.attempts.set(receipt.id, 'uncertain')
        })
        const valid = text === undefined || idle || isObject(value) && value.turnId === turnId
        if (valid) this.attempts.set(receipt.id, 'acknowledged')
      }
      try {
        if (text === undefined) {
          await codexRequest(host.transport, 'turn/interrupt', { threadId: target, turnId: turnId! }, undefined, late)
        } else {
          const params = { threadId: target, clientUserMessageId: receipt.nativeCorrelationId,
            input: [{ type: 'text' as const, text, text_elements: [] }] }
          if (idle) {
            const result = await codexRequest(host.transport, 'turn/start', params, undefined, late)
            await starting?.acknowledge(result)
          }
          else {
            const response = await codexRequest(host.transport, 'turn/steer', {
              ...params, expectedTurnId: turnId!,
            }, undefined, late)
            if (response.turnId !== turnId) throw new Error('Codex acknowledged another child turn.')
          }
        }
        current()
        this.attempts.set(receipt.id, 'acknowledged')
      } catch (error) {
        if (error instanceof CodexRpcError && !error.uncertain) {
          starting?.reject()
          this.attempts.set(receipt.id, 'rejected')
          throw new SubagentDispatchRejectedError({ cause: error })
        }
        throw error
      }
    })
    return {
      generation: host.generation,
      nativeTurnId: turnId,
      capabilities: { sendInput: capability(sendInput), interrupt: capability(interrupt),
        executionResume: capability(resume), inputTiming: 'active-and-idle' },
      assertCurrent: current,
      matches: other => {
        try {
          current()
          return other.id === child.id && other.parentExecutionId === child.parentExecutionId
            && other.parentAttemptKey === child.parentAttemptKey && isDeepStrictEqual(other.native, child.native)
            && isDeepStrictEqual(other.profile, child.profile)
        } catch (error) { logIgnoredError('harness', 'check native child control', error, {}, ['SUBAGENT_OWNER_STALE']); return false }
      },
      ...(sendInput ? { sendInput: (receipt: RunSubagentCommandReceipt, text: string) => dispatch(receipt, text) } : {}),
      ...(interrupt ? { interrupt: (receipt: RunSubagentCommandReceipt) => dispatch(receipt) } : {}),
      reconcile: receipt => host.exclusive(async () => {
        checkReceipt(receipt)
        await read()
        const known = this.attempts.get(receipt.id)
        if (known && known !== 'uncertain') return known
        return this.reconcile(target, receipt, host, current)
      }),
    }
  }

  private async ancestry(child: RunSubagent, thread: Thread, host: CodexChildControlHost, current: () => void) {
    let target = child.native.childSessionId!
    const visited = new Set<string>()
    while (target !== host.rootThreadId) {
      if (visited.has(target) || visited.size >= 32) throw new SubagentDispatchRejectedError()
      visited.add(target)
      const source = thread.source
      const subAgent = typeof source === 'object' && 'subAgent' in source ? source.subAgent : undefined
      const spawn = typeof subAgent === 'object' && 'thread_spawn' in subAgent ? subAgent.thread_spawn : undefined
      if (thread.id !== target || thread.ephemeral || !thread.parentThreadId
        || spawn?.parent_thread_id !== thread.parentThreadId
        || target === child.native.childSessionId && thread.parentThreadId !== child.native.parentSessionId) {
        throw new SubagentDispatchRejectedError()
      }
      target = thread.parentThreadId
      if (target !== host.rootThreadId) {
        const response = await codexRequest(host.transport, 'thread/read', { threadId: target, includeTurns: false })
        current()
        thread = response.thread
      }
    }
  }

  private async latestTurn(target: string, host: CodexChildControlHost, current: () => void): Promise<Turn | undefined> {
    const page = await codexRequest(host.transport, 'thread/turns/list', {
      threadId: target, cursor: null, limit: 1, sortDirection: 'desc',
    })
    current()
    return page.data[0]
  }

  private async reconcile(target: string, receipt: RunSubagentCommandReceipt,
    host: CodexChildControlHost, current: () => void): Promise<CommandOutcome> {
    let cursor: string | null = null
    const seen = new Set<string>()
    if (receipt.operation === 'run_subagent_interrupt_v1') {
      do {
        const page: ThreadTurnsListResponse = await codexRequest(host.transport, 'thread/turns/list', {
          threadId: target, cursor, limit: 50, sortDirection: 'desc',
        })
        current()
        const turn = page.data.find(value => value.id === receipt.nativeTurnId)
        if (turn) return turn.status === 'interrupted' ? 'acknowledged' : 'uncertain'
        cursor = page.nextCursor
        if (cursor && seen.has(cursor)) return 'uncertain'
        if (cursor) seen.add(cursor)
      } while (cursor)
      return 'uncertain'
    }
    do {
      const page: ThreadItemsListResponse = await codexRequest(host.transport, 'thread/items/list', {
        threadId: target, cursor, limit: 50, sortDirection: 'asc',
      })
      current()
      const match = page.data.find(({ item, turnId }) => item.type === 'userMessage'
        && item.clientId === receipt.nativeCorrelationId && (receipt.nativeTurnId === null || turnId === receipt.nativeTurnId))
      if (match) return 'acknowledged'
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) return 'uncertain'
      if (cursor) seen.add(cursor)
    } while (cursor)
    return 'uncertain'
  }
}
