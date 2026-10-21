import { CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, SavedManagedWorkflowCommandResultSchema } from '@foreman-code/contracts/wave25'
import { LOCAL_RUNNER_ID } from '../../src/modules/workspaces/location.js'
import { memoryCall, type MemoryRuntime } from './memoryWorkflow.js'

/** All new-Run assertions use the authenticated production admission endpoint. */
export async function prepareCoordinationWorkflow(runtime: MemoryRuntime) {
  const workspaceId = runtime.f.scope.workspaceId
  await memoryCall(runtime.client, 'workspace_location_set', { workspaceId, runnerId: LOCAL_RUNNER_ID,
    rootPath: runtime.db.directory, expectedLocationRevision: 1 })
  const created = SavedManagedWorkflowCommandResultSchema.parse(await memoryCall(runtime.client, 'workflow_create', {
    workspaceId, name: 'Coordinated workflow',
  })).value
  const saved = CurrentWorkflowSaveResultSchema.parse(await memoryCall(runtime.client, 'workflow_save_v3', {
    workspaceId, workflowId: created.workflow.id, executionSemanticsVersion: 3,
    expectedRevision: created.revision, expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: runtime.f.version.agentConfigurationVersionIds,
    graph: { ...runtime.f.version.definition, id: created.workflow.id, version: created.workflow.version,
      createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt },
  })).value
  const scope = { kind: 'workflow', workspaceId, workflowId: saved.workflowId }
  const board = await memoryCall(runtime.client, 'memory_board_get', { scope })
  return { scope, saved, boardId: (board.board as { id: string }).id,
    start: async () => RunStartV3ResultSchema.parse(await memoryCall(runtime.client, 'run_start', { workspaceId,
      workflowId: saved.workflowId, workflowVersionId: saved.version.id, executionSemanticsVersion: 3,
      expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 2, input: {},
    })),
  }
}
