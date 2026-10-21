import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema, ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { remoteReviewerPlacementFixture } from './helpers/remoteReviewerPlacement.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'

describe.skipIf(!postgresEnabled)('remote designated Orchestrator authoring over authenticated MCP', () => {
  it('validates, saves and reads the remote placement while denying a read-only caller', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { baseline, remote } = remoteReviewerPlacementFixture()
      expect(ExecutableWorkflowV3Schema.safeParse({ version: remote.version, configurations: remote.configurations }).success).toBe(true)
      await seedAgent3(f.db.pool, f.db.directory, baseline, { run: false })
      const scope = { workspaceId: baseline.scope.workspaceId, workflowId: baseline.scope.workflowId }
      const read = await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      const before = CurrentWorkflowReadResultSchema.parse(graphRpcValue(read as Parameters<typeof graphRpcValue>[0]))
      const input = CurrentWorkflowSaveInputSchema.parse({ ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: before.revision, expectedWorkflowVersionId: before.version.id,
        expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds,
        graph: { ...remote.version.definition, id: scope.workflowId, version: before.version.version,
          createdAt: before.version.definition.createdAt, updatedAt: before.version.definition.updatedAt } })
      const { commandId, ...validation } = input
      const validated = await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.validate, arguments: validation })
      expect(validated.isError).not.toBe(true)
      const savedResponse = await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })
      expect(savedResponse.isError).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(savedResponse as Parameters<typeof graphRpcValue>[0]))
      const reader = await f.access.issue({ name: 'Read-only workflow inspector', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [scope.workspaceId] } }] })
      const client = await f.connect(reader.token)
      const persisted = await client.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      const actual = CurrentWorkflowReadResultSchema.parse(graphRpcValue(persisted as Parameters<typeof graphRpcValue>[0]))
      expect(actual.version).toEqual(saved.value.version)
      const reviewer = actual.version.definition.nodes[0]
      if (!reviewer || reviewer.kind === 'job') throw new Error('The saved Orchestrator node is missing')
      expect(reviewer.placement).toEqual(remote.version.definition.nodes[0]!.placement)
      const denied = await client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: { ...input,
        commandId: randomUUID(), expectedRevision: actual.revision, expectedWorkflowVersionId: actual.version.id } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const after = await client.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })
      expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue(after as Parameters<typeof graphRpcValue>[0]))).toEqual(actual)
      expect((await f.db.pool.query('select 1 from runs where workflow_id=$1', [scope.workflowId])).rows).toEqual([])
      expect((await f.db.pool.query('select 1 from management_command_receipts where command_id=$1', [commandId])).rows).toHaveLength(1)
    } finally { await f.close() }
  }, 60_000)
})
