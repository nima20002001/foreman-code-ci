import { expect, it } from 'vitest'
import { createProductionWorkflowChat } from '../src/modules/collaboration/groupChatProduction.js'
import { createWorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatProduction.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import type { WorkflowChatChange } from '../src/modules/workflow-chat/model.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'

it('publishes later Run receipt changes after adoption without requiring another post or prepared command', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const agentRepository = new PostgresAgentChatRepository(f.db.pool)
  const messages = new PostgresOperatorConversationRepository(f.db.pool)
  const unavailable = () => { throw new Error('No standalone native session is needed') }
  const agent = new AgentChatService(f.db.pool, agentRepository, messages, f.workflows, f.runs, unavailable, f.db.directory)
  const operator = new OperatorChatService(messages, new PostgresOperatorRepository(f.db.pool), unavailable, f.db.directory,
    new PostgresOperatorChatAuthority(f.db.pool, f.access, new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }),
      f.db.directory, `${f.address}/mcp`))
  const execution = createWorkflowExecutionChatService(f.db.pool, f.native)
  const feature = createProductionWorkflowChat({ pool: f.db.pool, agent, operator, agentRepository, execution,
    bindConversationScope: async () => { throw new Error('No conversation rebind is needed') } })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  const events: WorkflowChatChange[] = []
  const unsubscribe = feature.service.events.subscribe(f.f.run.workflowId, event => events.push(event))
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'builder')
    const scope = { workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId }
    const posted = await feature.service.post(f.writer.principal, { ...scope, commandId: 'queued-group-input',
      body: '@builder address this next', mentions: [{ workflowNodeId: 'builder', start: 0, end: 8 }],
      deliveries: [{ workflowNodeId: 'builder', target, intent: 'next_turn' }], cardIds: [] })
    await feature.router.drainPrepared()
    await feature.projector.projectCommittedFacts()
    expect(await feature.repository.deliveries.pending()).toEqual([])
    const before = await feature.service.read(f.writer.principal, scope)
    events.length = 0
    const receiptId = posted.receipts[0]!.id
    await execution.cancel(f.writer.principal, { target, commandId: 'cancel-adopted-input', selection: { kind: 'one', receiptId } })
    await feature.projector.projectCommittedFacts()
    const after = await feature.service.read(f.writer.principal, scope)
    expect(after.items).toEqual(before.items)
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(events).toContainEqual({ revision: after.revision, snapshotRequired: true })
    expect((await feature.service.receipts(f.writer.principal, scope)).items).toContainEqual(
      expect.objectContaining({ id: receiptId, state: 'canceled' }))
    const count = events.length
    await feature.projector.projectCommittedFacts()
    expect(events).toHaveLength(count)
  } finally {
    unsubscribe(); provider.releaseAll(); await f.stop(); await drive
    await agent.shutdown(); await operator.shutdown(); await f.close()
  }
}, 60_000)
