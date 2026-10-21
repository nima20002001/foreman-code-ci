import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  ManualRunStartResultSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const integration = setupWorkflowCreateIntegration()

it('saves and starts default read-only Codex Agents without approval routing through authenticated MCP', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = { handler: 'native' }
  for (const configuration of fixture.configurations) {
    if (configuration.harness.harness === 'codex') {
      configuration.harness.advanced = structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION)
    }
  }
  const f = await integration({ fixture, approvalNodeIds: [] })
  try {
    const location = await f.db.pool.query<{ root: string }>(
      "select execution_location->>'rootPath' as root from workspaces where id=$1", [fixture.scope.workspaceId])
    const identity = await stat(location.rows[0]!.root, { bigint: true })
    await f.db.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
      [fixture.scope.workspaceId, JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) })])
    const input = await f.create()
    const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
    const savedReply = await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })
    expect(savedReply.isError, JSON.stringify(savedReply)).not.toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedReply)).value
    const reader = await f.access.issue({ name: 'Workflow reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['workflows:read', 'graph:read', 'runs:read'], scope: { workspaceIds: [input.workspaceId] } }],
    })
    const readClient = await f.connect(reader.token)
    const read = CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(
      await readClient.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: scope })))
    expect(read.version).toEqual(saved.version)
    expect(read.version.definition.approval).toEqual({ handler: 'native' })
    const start = { ...scope, workflowVersionId: saved.currentVersionId, executionSemanticsVersion: 3,
      expectedWorkflowRevision: saved.revision,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 1, commandId: randomUUID(), input: { message: 'Read the workspace.' } }
    await expectMcpAccessDenied(readClient.callTool({ name: 'run_start', arguments: start }))
    const started = await f.client.callTool({ name: 'run_start', arguments: start })
    expect(started.isError, JSON.stringify(started)).not.toBe(true)
    const result = ManualRunStartResultSchema.parse(decodeMcpToolResult(started))
    const persisted = decodeMcpToolResult(await readClient.callTool({ name: 'run_get', arguments: {
      workspaceId: scope.workspaceId, runId: result.run.id,
    } }))
    expect(persisted).toMatchObject({ run: { id: result.run.id, workflowVersionId: saved.currentVersionId } })
    const agent = ManagedAgentDetailSchema.parse(decodeMcpToolResult(await f.client.callTool({
      name: 'agent_get', arguments: { workspaceId: scope.workspaceId, agentId: fixture.configurations[0]!.agentId },
    })))
    expect(agent.agent.harnessConfiguration).toMatchObject({
      sandbox: 'read-only', advanced: { approvalPolicy: 'never' },
    })
    await f.client.callTool({ name: 'run_stop', arguments: {
      workspaceId: scope.workspaceId, runId: result.run.id, commandId: randomUUID(),
    } })
  } finally {
    await f.close()
  }
}, 120_000)
