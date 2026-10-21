import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/client'
import { memoryBoardTools, DEFAULT_CODEX_ADVANCED_CONFIGURATION, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedManagedWorkflowCommandResultSchema, CurrentWorkflowSaveResultSchema,
  RunStartV3ResultSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const reply = await client.callTool({ name, arguments: args })
  expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true)
  return decodeMcpToolResult(reply)
}

it.runIf(postgresEnabled)('creates and runs a board-write workflow through authenticated MCP and settles its cards', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
  fixture.configurations[0]!.harness = { harness: 'codex', model: 'synthetic-no-native-call',
    reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard',
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  let boardId: string
  let agentCardId: string | undefined
  let launchRequest: HarnessExecutionRequest | undefined
  const runtime: Awaited<ReturnType<typeof currentOperatorIntegration>> = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [],
    managerFactory: () => {
      const manager = runtime.provider.connection()
      let token: string
      return { ...manager,
        async createSession(input) {
          if (!isWorkflowStart(input)) throw new Error('Expected workflow launch')
          launchRequest = input.request
          token = input.environment!.variables[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]!
          return manager.createSession(input)
        },
        async *startTurn(session, input) {
          const agent = await runtime.connect(token)
          const tools = (await agent.listTools()).tools.map(tool => tool.name)
          expect(tools).toContain('memory_card_create')
          const created = await call(agent, 'memory_card_create', { kind: 'card_create', boardId,
            card: { title: 'Agent task', body: 'Written during the workflow', status: 'todo',
              completionKind: null, reason: null, assignee: null, linkedNodes: [] } })
          agentCardId = (created.card as { id: string }).id
          yield* manager.startTurn(session, input)
        },
      }
    },
  })
  try {
    const workspaceId = runtime.f.scope.workspaceId
    await call(runtime.client, 'workspace_location_set', { workspaceId, runnerId: LOCAL_RUNNER_ID,
      rootPath: runtime.db.directory, expectedLocationRevision: 1 })
    const created = SavedManagedWorkflowCommandResultSchema.parse(await call(runtime.client, 'workflow_create', {
      workspaceId, name: 'Workflow memory',
    })).value
    const graph = { ...runtime.f.version.definition, id: created.workflow.id, version: created.workflow.version,
      createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt }
    const saved = CurrentWorkflowSaveResultSchema.parse(await call(runtime.client, 'workflow_save_v3', {
      workspaceId, workflowId: created.workflow.id, executionSemanticsVersion: 3,
      expectedRevision: created.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: runtime.f.version.agentConfigurationVersionIds, graph,
    })).value
    const scope = { kind: 'workflow', workspaceId, workflowId: saved.workflowId }
    const board = await call(runtime.client, 'memory_board_get', { scope })
    boardId = (board.board as { id: string }).id
    await call(runtime.client, 'memory_note_create', { kind: 'note_create', boardId, text: 'Remember the deployment checklist.' })
    const node = saved.version.definition.nodes[0]!
    if (node.kind === 'job') throw new Error('Expected Agent node')
    const claimed = await call(runtime.client, 'memory_card_create', { kind: 'card_create', boardId,
      card: { title: 'Linked task', body: '', status: 'todo', completionKind: null, reason: null,
        assignee: null, linkedNodes: [] },
      workSelections: [{ kind: 'next_activation', node: { workspaceId, workflowId: saved.workflowId,
        workflowNodeId: node.id, agentId: node.agentId } }],
    })
    const started = RunStartV3ResultSchema.parse(await call(runtime.client, 'run_start', {
      workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.version.id,
      executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 2, input: {},
    }))
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(started.run.id))?.executionState).toBe('completed')
    }, { timeout: 30000, interval: 50 })
    expect(launchRequest?.initialPrompt).toContain('Remember the deployment checklist.')
    expect(agentCardId).toBeDefined()
    for (const cardId of [(claimed.card as { id: string }).id, agentCardId!]) {
      const detail = await call(runtime.client, 'memory_board_get', { boardId, view: 'card', cardId })
      expect(detail.card).toMatchObject({ id: cardId, status: 'done', completionKind: 'completed' })
      expect(detail.bindings).toEqual([expect.objectContaining({ state: 'accepted',
        work: expect.objectContaining({ runId: started.run.id }) })])
    }
    const reader = await runtime.access.issue({ name: 'Memory reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read'], scope: { workspaceIds: [workspaceId] } }] })
    const denied = await (await runtime.connect(reader.token)).callTool({ name: 'memory_card_update', arguments: {
      kind: 'card_update', boardId, cardId: agentCardId, patch: { body: 'Unauthorized' },
    } })
    expect(denied.isError).toBe(true)
    const persisted = await call(runtime.client, 'memory_board_get', { boardId, view: 'card', cardId: agentCardId })
    expect(persisted.card).toMatchObject({ body: 'Written during the workflow', status: 'done' })
    expect(runtime.dispatchErrors).toEqual([])
  } finally { await runtime.close() }
}, 60000)
