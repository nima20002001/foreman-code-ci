import type { AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import type { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import type { PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'

export function waitForDelivery(chat: Pick<AgentChatService, 'events'>,
  repository: Pick<PostgresAgentChatRepository, 'turn' | 'get'>,
  id: string, requestId: string, delivery: AgentChatTurn['delivery'],
  options: { timeoutMs?: number } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let reading = false
    let changed = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    const check = async () => {
      changed = true
      if (reading || settled) return
      reading = true
      try {
        do {
          changed = false
          const turn = await repository.turn(id, requestId)
          if (turn?.delivery === delivery) finish()
          else if (turn && ['failed', 'canceled', 'completed'].includes(turn.delivery)) {
            finish(new Error(`Expected ${delivery} for ${requestId}; observed ${JSON.stringify(turn)}.`))
          }
        } while (changed && !settled)
      } catch (error) {
        finish(error)
      } finally {
        reading = false
      }
    }
    const timeout = setTimeout(() => {
      void Promise.all([repository.turn(id, requestId), repository.get(id)]).then(([turn, conversation]) => {
        finish(new Error(`No persisted ${delivery} result for ${requestId}: `
          + JSON.stringify({ turn, state: conversation?.turn_state, error: conversation?.last_error })))
      }).catch(finish)
    }, options.timeoutMs ?? 30_000)
    // Subscribe before the snapshot; a commit during that read must trigger another read.
    const unsubscribe = chat.events.subscribe(id, (event) => {
      if (event.data.requestId === requestId && typeof event.data.delivery === 'string') void check()
    })
    void check()
  })
}
