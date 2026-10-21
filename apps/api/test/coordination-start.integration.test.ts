import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, memoryBoardTools, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, SavedManagedWorkflowCommandResultSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { LOCAL_RUNNER_ID } from '../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { memoryCall, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('pins the coordination protocol through production MCP Start and applies model board changes', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
  fixture.configurations[0]!.harness = { harness: 'codex', model: 'synthetic-no-native-call',
    reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard',
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  let boardId: string
  let request: HarnessExecutionRequest | undefined
  let original: { text: string }
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [],
    outputFor: () => {
      original = { text: JSON.stringify({ data: { text: 'Work complete' }, summary: 'Finished the task.', board: {
        kind: 'changes', operations: [{ kind: 'card_create', boardId,
          card: { title: 'Produced by the model result', body: '', status: 'todo', completionKind: null,
            reason: null, assignee: null, linkedNodes: [] } }],
      } }) }
      return original
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      return { ...manager, async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Expected workflow session')
        request = input.request
        return manager.createSession(input)
      } }
    },
  })
  try {
    const workspaceId = runtime.f.scope.workspaceId
    await memoryCall(runtime.client, 'workspace_location_set', { workspaceId, runnerId: LOCAL_RUNNER_ID,
      rootPath: runtime.db.directory, expectedLocationRevision: 1 })
    const created = SavedManagedWorkflowCommandResultSchema.parse(await memoryCall(runtime.client, 'workflow_create', {
      workspaceId, name: 'Coordination protocol workflow',
    })).value
    const saved = CurrentWorkflowSaveResultSchema.parse(await memoryCall(runtime.client, 'workflow_save_v3', {
      workspaceId, workflowId: created.workflow.id, executionSemanticsVersion: 3,
      expectedRevision: created.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: runtime.f.version.agentConfigurationVersionIds,
      graph: { ...runtime.f.version.definition, id: created.workflow.id, version: created.workflow.version,
        createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt },
    })).value
    const board = await memoryCall(runtime.client, 'memory_board_get', {
      scope: { kind: 'workflow', workspaceId, workflowId: saved.workflowId },
    })
    boardId = (board.board as { id: string }).id
    const started = RunStartV3ResultSchema.parse(await memoryCall(runtime.client, 'run_start', { workspaceId,
      workflowId: saved.workflowId, workflowVersionId: saved.version.id, executionSemanticsVersion: 3,
      expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 2, input: {},
    }))
    expect(started.run.resultProtocol).toBe('f1-f4-v1')
    await vi.waitFor(async () => expect((await runtime.runs.get(started.run.id))?.outcome).toBe('succeeded'),
      { timeout: 30000, interval: 50 })
    expect(request?.resultProtocol).toBe(started.run.resultProtocol)
    expect(request?.initialPrompt).toContain('summary')
    expect(request?.initialPrompt).toContain('board')
    const details = await runtime.runs.getDetails(workspaceId, started.run.id)
    expect(details?.executions[0]?.result).toEqual({ outcome: 'succeeded', output: original! })
    const done = await memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'cards', status: 'done' })
    expect(done.items).toEqual([expect.objectContaining({ title: 'Produced by the model result', completionKind: 'completed' })])
  } finally { await runtime.close() }
}, 60000)
