import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { ChatManager } from './helpers/operatorChatFixture.js'
import { readUntil } from './helpers/observableCondition.js'

it.each(['stopped', 'disconnected'] as const)(
  'disposes a local native owner after its stream is %s while retaining its unconfirmed message', async stream => {
  const db = await agent3Database()
  let chat: AgentChatService | undefined
  const native = new ChatManager()
  native.autoFinish = false
  const startTurn = native.startTurn.bind(native)
  native.startTurn = async function* (session, input, signal) {
    yield* startTurn(session, input, signal)
    if (stream === 'disconnected') signal?.throwIfAborted()
  }
  try {
    const seeded = await seedAgent3(db.pool, db.directory, makeCurrentWorkflowFixture(randomUUID(), 'sequential'), { run: false })
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const repository = new PostgresAgentChatRepository(db.pool)
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'local-chat') }, async () => {})
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Local chat sender', audience: 'operator',
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
    let releases = 0
    const factory = Object.assign(() => createAdmittedNativeManager('codex', async () => ({ manager: native })).manager,
      { release: () => { releases++ } })
    chat = new AgentChatService(db.pool, repository, new PostgresOperatorConversationRepository(db.pool),
      new PostgresWorkflowRepository(db.pool), {
        getForWorkspace: async () => { throw new Error('Fresh chat has no Run') },
        getExecution: async () => { throw new Error('Fresh chat has no execution') },
        executionPages: () => { throw new Error('Fresh chat has no execution pages') },
      }, factory, db.directory)
    await chat.send(writer.principal, context.workspaceId, { requestId: 'original-input', content: 'Run once',
      intent: 'next_turn', expectedConversationId: conversation.id,
      context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } })
    await readUntil(() => repository.get(conversation.id), row => Boolean(row?.active_native_turn_id),
      { timeoutMs: 2_000, description: 'the local native message acknowledgement' })
    const acknowledged = await repository.turn(conversation.id, 'original-input')
    expect(acknowledged).toMatchObject({ delivery: 'accepted', nativeTurnId: expect.any(String) })
    await expect(chat.shutdown()).resolves.toBeUndefined()
    expect(native.disposals).toBe(1)
    expect(releases).toBe(1)
    expect(native.turns).toBe(1)
    expect(native.sessions).toBe(1)
    expect(await repository.get(conversation.id)).toMatchObject({ active_request_id: 'original-input',
      active_native_turn_id: acknowledged!.nativeTurnId, last_result: null })
    expect((await repository.turn(conversation.id, 'original-input'))?.delivery)
      .toBe('accepted')
    await expect(chat.shutdown()).resolves.toBeUndefined()
    expect(native.disposals).toBe(1)
    expect(releases).toBe(1)
  } finally {
    if (native.disposals === 0) await native.dispose()
    await db.close()
  }
})
