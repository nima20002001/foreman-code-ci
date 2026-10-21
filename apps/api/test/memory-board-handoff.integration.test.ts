import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('keeps linked parent work Doing until its required child return commits', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  for (const configuration of fixture.configurations) configuration.harness = {
    harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only',
    serviceTier: 'standard', advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' },
  }
  let boardId: string
  let cardId: string
  let parentWhileChildRuns: unknown
  const readCard = async () => decodeMcpToolResult(await runtime.client.callTool({ name: 'memory_board_get',
    arguments: { boardId, view: 'card', cardId } }))
  const runtime: Awaited<ReturnType<typeof currentOperatorIntegration>> = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    outputFor: (_nodeId, request) => {
      const input = WorkActivationInputSchema.parse(request.input)
      const routing = input.work.kind === 'work_request'
        ? { kind: 'return', requestId: input.work.request.requestId, outcome: 'accepted' }
        : { kind: 'finish' }
      return { routing, data: { latestDeliverable: { text: 'Reviewed work' }, remainingFindings: [] } }
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      let child = false
      return { ...manager,
        async createSession(input) {
          if (!isWorkflowStart(input)) throw new Error('Expected workflow session')
          child = input.request.workflowNodeId !== fixture.version.entryNodeId
          return manager.createSession(input)
        },
        async *startTurn(session, input) {
          if (child) parentWhileChildRuns = await readCard()
          yield* manager.startTurn(session, input)
        },
      }
    },
  })
  try {
    const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    const board = decodeMcpToolResult(await runtime.client.callTool({ name: 'memory_board_get', arguments: { scope } }))
    boardId = (board.board as { id: string }).id
    const node = runtime.f.version.definition.nodes[0]!
    expect(node.kind).not.toBe('job')
    const created = decodeMcpToolResult(await runtime.client.callTool({ name: 'memory_card_create', arguments: {
      kind: 'card_create', boardId, card: { title: 'Reviewed task', body: '', status: 'todo', completionKind: null,
        reason: null, assignee: null, linkedNodes: [] },
      workSelections: [{ kind: 'next_activation', node: { workspaceId: scope.workspaceId, workflowId: scope.workflowId,
        workflowNodeId: node.id, agentId: node.agentId } }],
    } }))
    cardId = (created.card as { id: string }).id
    await runtime.engine.start(runtime.f.run.id)
    expect(parentWhileChildRuns).toMatchObject({ card: { status: 'doing' }, bindings: [{ state: 'waiting_children' }] })
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    expect(await readCard()).toMatchObject({ card: { status: 'done', completionKind: 'completed' },
      bindings: [{ state: 'accepted' }] })
  } finally { await runtime.close() }
}, 60000)
