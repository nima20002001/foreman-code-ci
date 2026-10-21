import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { SendAgentChatMessageResponseSchema, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'
import { measureIntegrationPhase } from './integrationPhase.js'
import { waitForRequesterSession } from './remoteReviewEntryStartup.js'

export async function historicalChatPlacement(
  scenario: (fixture: Awaited<ReturnType<typeof remoteReviewProduction>>) => Promise<void>,
  options: Pick<NonNullable<Parameters<typeof remoteReviewProduction>[0]>,
    'includeNodeRuntimePayload' | 'sourceAccessMode'> & { workflow?: 'single' | 'approval' } = {},
) {
  const fixture = await remoteReviewProduction({
    workflow: 'single', parallelSetup: true,
    ...options,
  })
  try {
    await measureIntegrationPhase('historical chat scenario', () => scenario(fixture))
  } catch (error) {
    console.error('Historical Worker chat scenario failed', { failures: fixture.failures() })
    throw error
  } finally {
    await measureIntegrationPhase('historical chat cleanup', () => fixture.close())
  }
}

export async function historicalChatSource(fixture: Awaited<ReturnType<typeof remoteReviewProduction>>,
  options: { parent?: 'active' | 'completed' } = {}) {
  const started = await measureIntegrationPhase('historical source Run start', () => fixture.start())
  // Native cleanup still changes the saved Run after it completes; fork against the settled record.
  if (options.parent === 'active') {
    await waitForRequesterSession({ entryNodeId: fixture.version.entryNodeId,
      readExecutions: async () => (await fixture.details(started.run.id)).executions,
      readCalls: fixture.provider.calls, reconcile: fixture.reconcileReviews,
      subscribe: fixture.subscribeNativeChanges,
    })
  }
  const before = options.parent === 'active' ? await fixture.details(started.run.id)
    : await measureIntegrationPhase('historical source Run completion',
    () => waitForRemoteReview(async () => {
      await fixture.reconcile()
      return fixture.details(started.run.id)
    }, value => value.run.executionState === 'completed' && value.cleanupPending !== true,
    'completed source Run with settled cleanup', fixture.subscribeNativeChanges))
  const execution = before.executions.find(value => value.workflowNodeId === fixture.version.entryNodeId)!
  expect(execution.state).toBe('completed')
  expect(execution.nativeSessionId).toBeTruthy()
  const workspaceId = fixture.version.workspaceId
  const selection = { workflowId: fixture.version.workflowId, runId: started.run.id,
    workflowNodeId: execution.workflowNodeId, executionId: execution.id }
  const read = async () => {
    const result = ReadSelectedRunChatResponseSchema.parse(await fixture.value('agent_chat_read', { workspaceId, selection }))
    if (result.kind !== 'selected') throw new Error('Expected the selected execution chat')
    return result.state
  }
  expect((await read()).conversation).toBeNull()
  return { started, before, execution, workspaceId, selection, read }
}

export async function forkHistoricalChat(
  fixture: Awaited<ReturnType<typeof remoteReviewProduction>>,
  source: Awaited<ReturnType<typeof historicalChatSource>>,
  message = { requestId: randomUUID(), content: 'Continue the saved task.', expectedConversationId: null },
) {
  const { started, execution, workspaceId, selection, read } = source
  const accepted = SendAgentChatMessageResponseSchema.parse(await measureIntegrationPhase('historical chat fork send',
    () => fixture.value('agent_chat_send', { workspaceId, selection, message })))
  const completed = await measureIntegrationPhase('historical chat fork completion',
    () => waitForHistoricalChatTurn(read, message.requestId, 'Worker chat fork completion'))
  expect(completed.conversation?.nativeSession?.nativeSessionId).not.toBe(execution.nativeSessionId)
  expect(completed.conversation?.origin).toEqual({ kind: 'run_execution', runId: started.run.id,
    executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId })
  const id = accepted.state.conversation!.id
  const saved = (await fixture.db.pool.query<{ worker_conversation_binding: unknown }>(
    'select worker_conversation_binding from operator_conversations where id=$1', [id])).rows[0]!
  const binding = WorkerConversationBindingSchema.parse(saved.worker_conversation_binding)
  expect(binding.profile.target.hostRef).toEqual(fixture.hostRef)
  expect(binding.profile.instanceId).toBe(fixture.profiles[0]!.instanceId)
  expect(binding.sourceExecution?.executionId).toBe(execution.id)
  return { ...source, message, completed, id }
}

export function waitForHistoricalChatTurn(read: () => Promise<AgentChatState>, requestId: string, description: string) {
  return waitForRemoteReview(read, state => {
    const turn = state.turns.find(turn => turn.requestId === requestId)
    if (turn?.delivery === 'completed') return true
    if (turn?.delivery === 'failed' || turn?.delivery === 'canceled') {
      const detail = turn.error ? `${turn.error.code}: ${turn.error.message}` : 'The turn did not complete.'
      throw new Error(`${description} ${turn.delivery}: ${detail}`)
    }
    if (state.sessionState === 'error' || state.sessionState === 'unavailable') {
      throw new Error(`${description} ${state.sessionState}: ${state.availability.reason ?? 'native_session_missing'}: `
        + (state.availability.message ?? 'The chat session cannot complete this turn.'))
    }
    return false
  }, description)
}
