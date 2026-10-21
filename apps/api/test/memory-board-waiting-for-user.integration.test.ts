import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, memoryBoardTools } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('keeps an Agent result card Waiting for user after its work is accepted, until the owner moves it', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
  fixture.configurations[0]!.harness = { harness: 'codex', model: 'synthetic-no-native-call',
    reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard',
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  let boardId: string
  const runtime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [], outputFor: () => ({
    text: JSON.stringify({ data: { deliverable: 'Cart ready' }, summary: 'Reached the payment page.', board: {
      kind: 'changes', operations: [{ kind: 'card_create', boardId, card: {
        title: 'Pay for the domain', body: 'Cart is ready at checkout.', status: 'waiting_for_user', completionKind: null,
        reason: 'Enter payment details on the checkout page.', assignee: null, linkedNodes: [],
      } }],
    } }),
  }) })
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await runtime.client.callTool({ name, arguments: args })
      expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true)
      return decodeMcpToolResult(reply)
    }
    const prepared = await prepareCoordinationWorkflow(runtime)
    boardId = prepared.boardId
    const started = await prepared.start()
    await vi.waitFor(async () => expect((await runtime.runs.get(started.run.id))?.executionState).toBe('completed'),
      { timeout: 30000, interval: 50 })
    const waiting = await call('memory_board_get', { boardId, view: 'cards', status: 'waiting_for_user' })
    expect(waiting.items).toEqual([expect.objectContaining({ title: 'Pay for the domain', status: 'waiting_for_user',
      reason: 'Enter payment details on the checkout page.' })])
    const card = (waiting.items as { id: string; revision: number }[])[0]!
    const view = await call('memory_board_get', { boardId })
    expect((view.openColumns as { status: string }[]).map(column => column.status)).toEqual(['todo', 'doing', 'waiting_for_user', 'blocked'])
    expect(view.counts).toMatchObject({ waiting_for_user: 1, done: 0 })
    await call('memory_card_update', { kind: 'card_update', boardId, cardId: card.id, commandId: randomUUID(),
      patch: { status: 'done', completionKind: 'completed', reason: null } })
    expect(await call('memory_board_get', { boardId })).toMatchObject({ counts: { waiting_for_user: 0, done: 1 } })
  } finally { await runtime.close() }
}, 60000)
