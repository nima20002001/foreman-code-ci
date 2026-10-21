import type { DeliveryTarget, EngineChatReadback } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'
import { requireAuthorization } from '../access/policy.js'
import type { ExecutionChatPort } from '../collaboration/ports.js'
import type { conversationDeliveryFixture } from '../conversations/conversationDelivery.test-support.js'
import { DomainError } from '../errors.js'
import { ChatDeliveryRouter, type ChatTargetAuthority, type ConversationDeliveryPort } from './delivery.js'
import { PostgresChatDeliveryRepository } from './deliveryRepository.js'

type Fixture = Awaited<ReturnType<typeof conversationDeliveryFixture>>
type EngineTarget = Extract<DeliveryTarget, { kind: 'workflow_execution' | 'workflow_coordinator' }>
type OwnerState = { settled: boolean; deliveries: number }

/** Only D's owner/target ports are fake. C still persists and reads the real immutable input journal. */
export function retainedExecutionFixture(fixture: Fixture, kind: EngineTarget['kind'],
  ownerState: OwnerState = { settled: false, deliveries: 0 }) {
  const original = fixture.feature.router, priorAuthority = fixture.feature.targetAuthority
  const repository = new PostgresChatDeliveryRepository(fixture.database.pool)
  const agent = { ...fixture.scope, workflowNodeId: fixture.query.workflowNodeId, agentId: fixture.query.agentId }
  const target: EngineTarget = kind === 'workflow_execution'
    ? { kind, agent, execution: { runId: 'retained-run', workflowVersionId: fixture.saved.version.id,
      executionId: 'retained-execution', activationId: 'retained-activation', attempt: 1 } }
    : { kind, agent, runId: 'retained-run', waitingActivationId: 'retained-waiting-activation' }
  const authorize = async (principal: ManagementPrincipal, selected: EngineTarget, action: 'read' | 'write' | 'cancel') => {
    requireAuthorization(principal, `agent_chat:${action}`, selected.agent)
    requireAuthorization(await fixture.access.currentOperator(principal.id), `agent_chat:${action}`, selected.agent)
    if (commandInputHash(selected.agent) !== commandInputHash(agent)) {
      throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'The selected target is outside this scoped owner.', 403)
    }
    if (action !== 'read' && commandInputHash(selected) !== commandInputHash(target)) {
      throw new DomainError('TARGET_SETTLED', 'The selected owner no longer accepts new input.', 409)
    }
    return principal
  }
  const authority: ChatTargetAuthority = {
    authenticate: (principal, selected, action) => selected.kind === 'workflow_execution' || selected.kind === 'workflow_coordinator'
      ? authorize(principal, selected, action) : priorAuthority.authenticate(principal, selected, action),
    authorizeLocked: async (tx, principal, selected, action) => {
      if (selected.kind === 'workflow_execution' || selected.kind === 'workflow_coordinator') await authorize(principal, selected, action)
      else await priorAuthority.authorizeLocked(tx, principal, selected, action)
    },
    qualifyLocked: async (tx, principal, request) => {
      if (request.target.kind !== 'workflow_execution' && request.target.kind !== 'workflow_coordinator') {
        return priorAuthority.qualifyLocked(tx, principal, request)
      }
      await authorize(principal, request.target, 'write')
      if (ownerState.settled) throw new DomainError('TARGET_SETTLED', 'The selected owner has settled.', 409)
      return { appliedIntent: 'next_turn', ownerBinding: {} }
    },
    restorePrincipal: id => fixture.access.currentOperator(id),
  }
  const execution: ExecutionChatPort = {
    deliver: async (principal, request) => {
      if (!request.commandId) throw new Error('Expected the prepared command identity.')
      const input = { ...request, commandId: request.commandId }
      ownerState.deliveries++
      const admitted = await withTransaction(repository.pool, tx => repository.adoptPreparedLocked(tx, principal.id,
        input, async () => undefined))
      return admitted.command.receipt
    },
    read: async (_principal, request): Promise<EngineChatReadback> => {
      const page = await repository.targetSnapshot(request.target, undefined, 100)
      return { target: request.target, state: ownerState.settled ? 'idle' : 'queued',
        capabilities: { steer: 'unavailable', queue: !ownerState.settled, interruptAndSend: false },
        messages: [], receipts: page.rows.map(row => row.receipt), nextCursor: null, hasMore: false, revision: page.revision }
    },
    stop: async () => { throw new Error('This never-native recovery case does not stop an active turn.') },
    cancel: async () => { throw new Error('This never-native recovery case settles at the owner boundary.') },
  }
  const conversation: ConversationDeliveryPort = {
    deliver: async () => { throw new Error('Run-owned input must never fall back to a standalone native conversation.') },
    read: async (principal, request) => {
      const result = await original.read(principal, request)
      if (!('state' in result)) throw new Error('Expected an unchanged native conversation read.')
      return result
    },
    stop: (principal, request) => original.stop(principal, request),
    cancel: (principal, request) => original.cancel(principal, request),
  }
  return { target, router: new ChatDeliveryRouter(repository, authority, execution, conversation, conversation), ownerState,
    deliveries: () => ownerState.deliveries,
    async settle() {
      const queued = await repository.targetSnapshot(target, undefined, 100)
      await withTransaction(repository.pool, async tx => {
        for (const command of queued.rows) await repository.updateLocked(tx, { ...command.receipt,
          state: 'failed', errorCode: 'TARGET_SETTLED', updatedAt: new Date().toISOString() })
      })
      ownerState.settled = true
    } }
}
