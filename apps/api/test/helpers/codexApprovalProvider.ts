import { randomUUID } from 'node:crypto'
import type { CodexSessionDependencies } from '../../src/modules/harnesses/codexAppServer.js'
import { object, type JsonObject } from '../../src/modules/harnesses/codexStdioTransport.js'
import { ActivityProductionReplay } from './activityProductionReplay.js'

export interface ApprovalProviderOptions {
  onRequest?: (executionId: string, method: string, params: JsonObject | undefined) => void
  command?: string
  workflowOutput?: (executionId: string) => Promise<string>
}

/** Protocol replay below the real Codex adapter; retained provider history survives manager replacement. */
export class CodexApprovalProvider extends ActivityProductionReplay {
  beforeReply?: () => Promise<void>
  private readonly pendingTasks = new Set<Promise<void>>()
  private readonly failures: unknown[] = []

  constructor(readonly executionId: string, private readonly completesWorkflowTurn: boolean,
    private readonly options: ApprovalProviderOptions = {}) {
    super(`approval-${executionId}`)
  }

  dependencies(): Extract<CodexSessionDependencies, { mode: 'replay' }> {
    const dependencies = this.infrastructure().codex
    if (!dependencies || dependencies.mode !== 'replay') throw new Error('Expected Codex replay dependencies')
    const transport = dependencies.transport
    return { ...dependencies, now: () => new Date(), transport: (...args) => {
      const connection = transport(...args)
      return { ...connection,
        request: async (method, params, signal, late) => {
          this.options.onRequest?.(this.executionId, method, params)
          const result = await connection.request(method, params, signal, late)
          if (method === 'turn/start') {
            const sessionId = String(params?.threadId)
            const turn = object(object(result).turn)
            const correlationId = String(params?.clientUserMessageId)
            if (correlationId === `execution:${this.executionId}`) {
              this.schedule(async () => {
                if (this.completesWorkflowTurn) {
                  const output = await this.options.workflowOutput?.(this.executionId) ?? 'entry complete'
                  this.complete(sessionId, String(turn.id), output)
                } else {
                  await this.requestApproval(sessionId, String(turn.id))
                }
              })
            }
          }
          return result
        },
        respond: async (rpcId, _method, result) => {
          const sessionId = this.requests.get(rpcId)
          if (!sessionId || connection.isConnected?.() !== true) throw new Error('Approval callback lost its owner')
          await this.beforeReply?.()
          const thread = this.threads.get(sessionId)!
          const turn = thread.turns.at(-1)!
          const output = await this.options.workflowOutput?.(this.executionId) ?? 'finished'
          this.responses.push({ sessionId, rpcId })
          this.requests.delete(rpcId)
          this.toolReplies.set(rpcId, object(result))
          this.schedule(async () => {
            const channel = this.channels.get(sessionId)!
            channel.notify('serverRequest/resolved', { threadId: sessionId, requestId: rpcId })
            const item = { type: 'commandExecution', id: 'recorded-command', command: this.command,
              cwd: thread.settings.cwd, status: 'completed', exitCode: 0, aggregatedOutput: '' }
            turn.items.push(item)
            channel.notify('item/completed', { threadId: sessionId, turnId: turn.id, item })
            this.completeReview(`execution:${this.executionId}`, sessionId, output)
          })
        },
      }
    } }
  }

  private get command(): string { return this.options.command ?? 'recorded readonly command' }

  private async requestApproval(sessionId: string, nativeTurnId: string): Promise<void> {
    const rpcId = randomUUID()
    this.requests.set(rpcId, sessionId)
    await this.channels.get(sessionId)!.request({ id: rpcId, method: 'item/commandExecution/requestApproval',
      params: { threadId: sessionId, turnId: nativeTurnId, itemId: 'recorded-command', command: this.command,
        cwd: this.threads.get(sessionId)!.settings.cwd,
        availableDecisions: ['accept', 'decline', 'cancel'] } })
  }

  finishFromHistory(correlationId: string, sessionId: string, output = 'finished'): JsonObject {
    const thread = this.threads.get(sessionId)
    const turn = thread?.turns.find(candidate => candidate.items.some(item => item.clientId === correlationId))
    if (!turn) throw new Error('Expected the original correlated Codex turn')
    turn.items.push({ type: 'agentMessage', id: `answer-${turn.id}`, text: output, phase: 'final_answer' })
    turn.status = 'completed'
    turn.completedAt = 2
    return structuredClone(turn)
  }

  completeReview(correlationId: string, sessionId: string, output = 'Review complete'): void {
    const turn = this.finishFromHistory(correlationId, sessionId, output)
    const channel = this.channels.get(sessionId)!
    const items = turn.items as JsonObject[]
    channel.notify('item/completed', { threadId: sessionId, turnId: turn.id, item: items.at(-1)! })
    channel.notify('turn/completed', { threadId: sessionId, turn })
  }

  private schedule(operation: () => Promise<void>): void {
    const task = new Promise<void>(resolve => setImmediate(resolve)).then(operation)
    this.pendingTasks.add(task)
    void task.then(() => this.pendingTasks.delete(task), error => {
      this.failures.push(error)
      this.pendingTasks.delete(task)
    })
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingTasks])
    if (this.failures.length) throw new AggregateError(this.failures, 'Codex approval replay failed')
  }
}
