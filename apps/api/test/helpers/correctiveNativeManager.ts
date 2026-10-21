import type { ExecutionResult, NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory } from '../../src/modules/harnesses/port.js'

export interface CorrectiveRequest { sessionId: string; correlationId: string; prompt: string }

/** External provider behavior only: every requested corrective turn gets its own retained history. */
export function correctiveNativeManager(base: NativeHarnessSessionManager, requests: CorrectiveRequest[],
  output: (request: CorrectiveRequest) => ExecutionResult): NativeHarnessSessionManager {
  const histories = new Map<string, NativeHistory>()
  let current: NativeHistory | undefined
  return { ...base,
    async *startTurn(session, input) {
      const correlationId = input.clientCorrelationId!
      if (!correlationId.includes(':result-repair:')) {
        yield* base.startTurn(session, input)
        return
      }
      if (histories.has(correlationId)) throw new Error('The provider received a duplicate corrective turn')
      const request = { sessionId: session.nativeSessionId, correlationId, prompt: input.prompt }
      requests.push(request)
      const providerId = `corrective-turn-${requests.length}`
      await input.onSubmitted?.(providerId)
      const event = (offset: number, type: string): NativeHarnessEvent => ({ sequence: requests.length * 2 + offset, type,
        occurredAt: new Date().toISOString(), payload: { threadId: session.nativeSessionId, turnId: providerId,
          clientCorrelationId: correlationId, status: type === 'turn.completed' ? 'completed' : 'inProgress' } })
      const terminal = event(1, 'turn.completed')
      const result = output(request)
      current = { correlationId, events: [terminal], pendingInteractions: [], nativeTurnId: providerId,
        terminalResult: result, terminalTurn: { correlationId, providerId, result } }
      histories.set(correlationId, current)
      yield event(0, 'turn.started')
      yield terminal
    },
    history: async (session, signal) => current ?? base.history(session, signal),
    reconcile: async (session, correlationId, signal) => histories.get(correlationId) ?? base.reconcile(session, correlationId, signal),
  }
}
