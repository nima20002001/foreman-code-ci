import { expect, it } from 'vitest'
import { WorkflowChatPostResponseSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createProductionWorkflowChat } from '../src/modules/collaboration/groupChatProduction.js'
import { createWorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatProduction.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'

it('asks the waiting master through authenticated Group MCP without changing its delegated work', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const agentRepository = new PostgresAgentChatRepository(f.db.pool)
  const operatorRepository = new PostgresOperatorConversationRepository(f.db.pool)
  const unavailableStandalone = () => { throw new Error('This hierarchy fixture has no standalone native sessions.') }
  const agent = new AgentChatService(f.db.pool, agentRepository, operatorRepository, f.workflows, f.runs,
    unavailableStandalone, f.db.directory)
  const operator = new OperatorChatService(operatorRepository, new PostgresOperatorRepository(f.db.pool),
    unavailableStandalone, f.db.directory, new PostgresOperatorChatAuthority(f.db.pool, f.access,
      new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), f.db.directory, `${f.address}/mcp`))
  const feature = createProductionWorkflowChat({ pool: f.db.pool, agent, operator, agentRepository,
    execution: createWorkflowExecutionChatService(f.db.pool, f.native),
    bindConversationScope: async () => { throw new Error('No standalone conversation may be rebound by this Run.') } })
  Object.assign(f.services, { workflowChat: feature.service, chatDelivery: feature.router })
  const stopDrain = feature.start()
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'master')
    expect(target.kind).toBe('workflow_coordinator')
    const before = (await f.runs.listRepeatExecutions(f.f.run.id)).map(row => row.execution)
    const scope = { workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId }
    const request = { ...scope, commandId: 'master-question', body: '@master explain current progress',
      mentions: [{ workflowNodeId: 'master', start: 0, end: 7 }],
      deliveries: [{ workflowNodeId: 'master', target, intent: 'next_turn' }], cardIds: [] }
    const response = await f.client.callTool({ name: 'workflow_chat_post', arguments: request })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const posted = WorkflowChatPostResponseSchema.parse(decodeMcpToolResult(response))
    expect(posted.receipts).toHaveLength(1)
    await expect.poll(() => provider.consultations.length, { timeout: 15_000 }).toBe(1)
    expect((await f.runs.listRepeatExecutions(f.f.run.id)).map(row => row.execution)).toEqual(before)
    const read = await f.client.callTool({ name: 'workflow_chat_read', arguments: { ...scope, postId: posted.post.id } })
    expect(read.isError, JSON.stringify(read)).not.toBe(true)
    expect(decodeMcpToolResult(read)).toMatchObject({ items: [posted.post] })
    const replay = await f.client.callTool({ name: 'workflow_chat_post', arguments: request })
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true)
    expect(WorkflowChatPostResponseSchema.parse(decodeMcpToolResult(replay)).receipts[0]?.id).toBe(posted.receipts[0]!.id)
    expect(provider.consultations).toHaveLength(1)
    await expect.poll(async () => {
      const page = await f.client.callTool({ name: 'workflow_chat_read', arguments: scope })
      expect(page.isError, JSON.stringify(page)).not.toBe(true)
      return decodeMcpToolResult(page)
    }, { timeout: 15_000 }).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
      replyToPostId: posted.post.id, body: 'The delegated work is still in progress.',
    })]) })
    provider.release('builder')
    expect(await drive).not.toBeInstanceOf(Error)
  } finally {
    stopDrain()
    provider.releaseAll()
    await f.stop()
    await drive
    await agent.shutdown()
    await operator.shutdown()
    await f.close()
  }
}, 60_000)
