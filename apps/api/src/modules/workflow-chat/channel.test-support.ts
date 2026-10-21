import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { ChatSendRequest, DeliveryTarget, EngineChatReadback, ChatControlReceipt } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ExecutionChatPort } from '../collaboration/ports.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { workflowChatMigration } from '../../infrastructure/workflowChatMigration.js'
import { DomainError } from '../errors.js'
import { ChatDeliveryRouter, type ChatTargetAuthority } from './delivery.js'
import { PostgresWorkflowChatRepository } from './repository.js'
import { WorkflowChatService } from './service.js'
import type { WorkflowChatAuthority } from './model.js'

export const caller: ManagementPrincipal = { id: 'user', name: 'User', audience: 'user', revokedAt: null,
  expiresAt: '9999-12-31T23:59:59.999Z', grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'],
    scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } }] }
export const scope = { workspaceId: 'workspace', workflowId: 'workflow' }
export const target: Extract<DeliveryTarget, { kind: 'workflow_execution' }> = { kind: 'workflow_execution', agent: { ...scope, workflowNodeId: 'node', agentId: 'agent' },
  execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', activationId: 'activation', attempt: 1 } }
const qualification = { appliedIntent: 'next_turn' as const, ownerBinding: { configurationVersionId: 'configuration' } }

export async function channelFixture() {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('Set TEST_DATABASE_URL to the disposable integration database.')
  const schema = `chat_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await admin.query(`create schema ${schema}`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  await pool.query(workflowChatMigration.sql)
  await pool.query('create table fake_native_owner(command_id text primary key, receipt_id text not null)')
  const repository = new PostgresWorkflowChatRepository(pool)
  let mutableTargetValid = true, authorized = true, postAsAgent = false
  let crashBeforeAdoption = false, crashAfterNative = false, nativeSubmissions = 0
  const check = (principal: ManagementPrincipal, selected: { workspaceId: string; workflowId: string }) => {
    if (!authorized || principal.id !== caller.id || selected.workspaceId !== scope.workspaceId
      || ![scope.workflowId, 'other-workflow'].includes(selected.workflowId)) {
      throw new DomainError('FORBIDDEN', 'The selected workflow is unavailable.', 403)
    }
  }
  const authority: WorkflowChatAuthority = {
    authenticate: async (principal, selected) => {
      check(principal, selected)
      return { principal, author: postAsAgent ? { kind: 'agent', agent: { ...target.agent, displayName: 'Agent',
        productRole: 'coder', configurationVersionId: 'configuration' } } : { kind: 'user', principalId: caller.id, displayName: caller.name } }
    },
    authorizeLocked: async (_tx, principal, selected) => { check(principal, selected) },
    validateLinksLocked: async () => {},
    validateRecipientLocked: async (_tx, _principal, input) => {
      if (!mutableTargetValid) throw new DomainError('TARGET_SETTLED', 'The exact target settled.', 409)
      if (input.target.kind === 'operator_conversation' || input.target.agent.agentId !== 'agent') throw new DomainError('TARGET_CHANGED', 'The selected recipient changed.', 409)
      return qualification
    },
  }
  const targetAuthority: ChatTargetAuthority = {
    authenticate: async (principal, selected) => { check(principal, selected.kind === 'operator_conversation' ? scope : selected.agent); return principal },
    authorizeLocked: async (_tx, principal, selected) => { check(principal, selected.kind === 'operator_conversation' ? scope : selected.agent) },
    qualifyLocked: async () => {
      if (!mutableTargetValid) throw new DomainError('TARGET_SETTLED', 'The exact target settled.', 409)
      return qualification
    },
    restorePrincipal: async id => { if (id !== caller.id) throw new DomainError('FORBIDDEN', 'Unknown principal.', 403); return caller },
  }
  const owner: ExecutionChatPort = {
    deliver: async (principal, request) => {
      if (!request.commandId) throw new Error('Expected durable command ID')
      const input: ChatSendRequest & { commandId: string } = { ...request, commandId: request.commandId }
      if (crashBeforeAdoption) throw new Error('Process stopped before owner adoption')
      const admission = await withTransaction(pool, tx => repository.deliveries.adoptPreparedLocked(tx, principal.id, input, async command => {
        await tx.query('insert into fake_native_owner(command_id,receipt_id) values($1,$2)', [input.commandId, command.receipt.id])
      }))
      if (!admission.adopted) return admission.command.receipt
      nativeSubmissions++
      if (crashAfterNative) throw new Error('Native accepted, response lost')
      await withTransaction(pool, tx => repository.deliveries.bindNativeSessionLocked(tx, admission.command.receipt.id, `session:${input.commandId}`))
      await repository.deliveries.update({ ...admission.command.receipt, state: 'accepted', nativeTurnId: `native:${input.commandId}`,
        updatedAt: new Date().toISOString() })
      return (await repository.deliveries.byReceipt(admission.command.receipt.id))!.receipt
    },
    read: async (_principal, input): Promise<EngineChatReadback> => ({ target: input.target, state: 'idle',
      capabilities: { steer: 'unavailable', queue: true, interruptAndSend: false }, messages: [],
      receipts: (await repository.deliveries.targetSnapshot(input.target, undefined, 100)).rows.map(row => row.receipt),
      nextCursor: null, hasMore: false, revision: await repository.deliveries.targetRevision(input.target) }),
    stop: async (_principal, input): Promise<ChatControlReceipt> => ({ commandId: input.commandId ?? randomUUID(), target: input.target,
      operation: input.scope === 'active_turn' ? 'stop_active' : 'stop_active_and_queued', state: 'completed', affectedReceiptIds: [], replayed: false }),
    cancel: async (_principal, input): Promise<ChatControlReceipt> => ({ commandId: input.commandId ?? randomUUID(), target: input.target,
      operation: input.selection.kind === 'one' ? 'cancel_one' : 'cancel_all_queued', state: 'completed', affectedReceiptIds: [], replayed: false }),
  }
  const delivery = new ChatDeliveryRouter(repository.deliveries, targetAuthority, owner, owner, owner)
  const service = new WorkflowChatService(repository, authority, delivery)
  return { pool, repository, service, delivery, owner, targetAuthority, authority,
    nativeSubmissions: () => nativeSubmissions,
    change: (values: { targetValid?: boolean; authorized?: boolean; agentAuthor?: boolean; beforeAdoption?: boolean; afterNative?: boolean }) => {
      mutableTargetValid = values.targetValid ?? mutableTargetValid; authorized = values.authorized ?? authorized
      postAsAgent = values.agentAuthor ?? postAsAgent
      crashBeforeAdoption = values.beforeAdoption ?? crashBeforeAdoption; crashAfterNative = values.afterNative ?? crashAfterNative
    },
    close: async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() },
  }
}
